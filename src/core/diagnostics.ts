// src/core/diagnostics.ts
//
// This module reports internal errors of the library. It limits the emit rate.
// It counts every event.

import { DIAGNOSTIC_THROTTLE_MS, LIBRARY_LOG_PREFIX } from "../constants";
import { runAsLibraryConsole } from "../utils/library-console";

/** Closed set of diagnostic event codes emitted by library subsystems. */
export type DiagnosticCode =
  | "config.invalid"
  | "config.reconfigured"
  | "record.sanitize_failed"
  | "record.truncated"
  | "record.dropped_by_level"
  | "record.dropped_by_sampling"
  | "record.dropped_by_ceiling"
  | "record.dropped_by_redact"
  | "record.dropped_boot_buffer_full"
  | "record.dropped_malformed"
  | "record.dropped_no_destination"
  | "runtime.version_mismatch"
  | "journey.expired"
  | "journey.adopted"
  | "journey.token_too_large"
  | "trace.otel_failed"
  | "bus.role_resolved"
  | "bus.no_owner"
  | "bus.handshake_timeout"
  | "bus.untrusted_origin"
  | "bus.send_failed"
  | "transport.http_error"
  | "transport.timeout"
  | "transport.batch_split"
  | "transport.throttled"
  | "transport.dropped_permanent"
  | "transport.rejected_credentials"
  | "transport.serialize_failed"
  | "storage.unavailable"
  | "storage.degraded"
  | "storage.quota_exceeded"
  | "storage.evicted"
  | "storage.dead_lettered"
  | "pipeline.crashed"
  | "capture.install_failed"
  | "capture.rate_limited"
  | "capture.header_failed"
  | "capture.record_failed"
  | "capture.transport_request"
  | "openfin.unavailable"
  | "platform.api_blocked"
  | "handler.threw";

/** Diagnostic event payload dispatched to consumer handlers. */
export interface DiagnosticEvent {
  /** Diagnostic fault code. */
  code: DiagnosticCode;
  /** Description for a person to read. */
  message: string;
  /** Structured context metadata. */
  detail?: Record<string, unknown>;
  /** Caught error instance or reason. */
  cause?: unknown;
  /** Event timestamp in epoch milliseconds. */
  at: number;
  /** Total count of this code since startup. It includes rate-limited occurrences. */
  count: number;
}

/** Consumer callback for receiving rate-limited diagnostic events. */
export type DiagnosticHandler = (event: DiagnosticEvent) => void;

/** Reports internal errors. It limits the dispatch rate but counts every event. */
export class Diagnostics {
  /** Running occurrence counts per diagnostic code. */
  private readonly counters = new Map<DiagnosticCode, number>();

  /** Timestamp of last emitted event per code in epoch milliseconds. */
  private readonly lastEmitted = new Map<DiagnosticCode, number>();

  /**
   * @param handler Optional diagnostic event listener callback.
   * @param throttleMs Minimum duration in milliseconds between emitted events for a single code.
   */
  constructor(
    private handler?: DiagnosticHandler,
    private readonly throttleMs = DIAGNOSTIC_THROTTLE_MS,
  ) {}

  /**
   * Updates or removes the active diagnostic event handler.
   * @param handler New diagnostic event handler.
   */
  setHandler(handler?: DiagnosticHandler): void {
    this.handler = handler;
  }

  /**
   * Increments the count for a code. It does not call the handler.
   * @param code Diagnostic code to increment.
   * @param by Increment delta.
   * @returns New total for the code.
   */
  count(code: DiagnosticCode, by = 1): number {
    const total = (this.counters.get(code) ?? 0) + by;
    this.counters.set(code, total);
    return total;
  }

  /**
   * Increments the counter for the code. It sends the event to the handler when the
   * throttle window has passed. It never throws.
   * @param code Diagnostic code.
   * @param message Event description.
   * @param detail Optional structured metadata.
   * @param cause Caught error instance or reason.
   */
  report(
    code: DiagnosticCode,
    message: string,
    detail?: Record<string, unknown>,
    cause?: unknown,
  ): void {
    const count = this.count(code);
    const now = Date.now();
    const last = this.lastEmitted.get(code) ?? 0;
    if (now - last < this.throttleMs) {
      return;
    }
    this.lastEmitted.set(code, now);

    const event: DiagnosticEvent = {
      code,
      message,
      detail,
      cause,
      at: now,
      count,
    };

    const { handler } = this;

    if (!handler) {
      return;
    }
    try {
      // The console capture skips a console call of the handler. Without the scope, the line
      // gives a record, and a failed send of that record gives a new diagnostic.
      runAsLibraryConsole(() => {
        handler(event);
      });
    } catch (handlerError) {
      // Increment the counter directly. A call to report() recurses when the handler throws.
      this.count("handler.threw");
      if (typeof console !== "undefined") {
        // The console capture skips a call in this scope.
        runAsLibraryConsole(() => {
          // eslint-disable-next-line no-console -- Fallback sink when diagnostic handler throws.
          console.warn(
            `${LIBRARY_LOG_PREFIX} The onDiagnostic handler threw an error.`,
            handlerError,
          );
        });
      }
    }
  }

  /**
   * Executes a synchronous function and reports any thrown error to diagnostics.
   * @param code Diagnostic code to report on throw.
   * @param message ASD-STE100 sentence that states the failure. The handler gets it as the event message.
   * @param fn Function to execute.
   * @returns Function return value, or undefined on throw.
   */
  guard<T>(code: DiagnosticCode, message: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      this.report(code, message, undefined, error);
      return undefined;
    }
  }

  /**
   * Executes an asynchronous function and reports any rejected promise to diagnostics.
   * @param code Diagnostic code to report on rejection.
   * @param message ASD-STE100 sentence that states the failure. The handler gets it as the event message.
   * @param fn Async function to execute.
   * @returns Promise that resolves to the return value, or undefined on rejection.
   */
  async guardAsync<T>(
    code: DiagnosticCode,
    message: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.report(code, message, undefined, error);
      return undefined;
    }
  }

  /**
   * Returns a copy of all cumulative diagnostic event counts since initialization.
   * @returns Map of diagnostic codes to occurrence counts.
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}
