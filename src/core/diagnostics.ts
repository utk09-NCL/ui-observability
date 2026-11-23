// src/core/diagnostics.ts
//
// Reports the library's internal errors. Emits are rate limited, but every event is counted.

import { DIAGNOSTIC_THROTTLE_MS, LIBRARY_LOG_PREFIX } from "../constants";
import { runAsLibraryConsole } from "../utils/library-console";

/** Closed set of diagnostic event codes emitted by library subsystems. */
export type DiagnosticCode =
  | "config.locked"
  | "security.rotated"
  | "security.rotation_failed"
  | "security.context_mismatch"
  | "record.dropped_during_rotation"
  | "bus.rejected_message"
  | "bus.journey_denied"
  | "config.invalid"
  | "config.reconfigured"
  | "record.sanitize_failed"
  | "record.truncated"
  | "record.dropped_by_level"
  | "record.dropped_by_sampling"
  | "record.dropped_by_ceiling"
  | "record.dropped_by_processor"
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
  | "bus.tab_id_changed"
  | "bus.no_owner"
  | "bus.handshake_timeout"
  | "bus.untrusted_origin"
  | "bus.send_failed"
  | "bus.protocol_mismatch"
  | "transport.http_error"
  | "transport.timeout"
  | "transport.batch_split"
  | "transport.partial_success"
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
  | "capture.trace_header_kept"
  | "capture.record_failed"
  | "capture.transport_request"
  | "openfin.unavailable"
  | "platform.api_blocked"
  | "handler.threw";

/** Diagnostic event payload dispatched to consumer handlers. */
export interface DiagnosticEvent {
  /** Diagnostic fault code. */
  code: DiagnosticCode;
  /** Human-readable description. */
  message: string;
  /** Structured context metadata. */
  detail?: Record<string, unknown>;
  /** Caught error instance or reason. */
  cause?: unknown;
  /** Event timestamp in epoch milliseconds. */
  at: number;
  /** Total count of this code since startup, including rate-limited occurrences. */
  count: number;
}

/** Consumer callback for receiving rate-limited diagnostic events. */
export type DiagnosticHandler = (event: DiagnosticEvent) => void;

/** Reports internal errors. Dispatch is rate limited, but every event is counted. */
export class Diagnostics {
  /** Running occurrence counts per diagnostic code. */
  private readonly counters = new Map<DiagnosticCode, number>();

  /** Timestamp of the last emitted event per code, in epoch milliseconds. */
  private readonly lastEmitted = new Map<DiagnosticCode, number>();

  /**
   * @param handler Optional listener for diagnostic events.
   * @param throttleMs Minimum time in milliseconds between emitted events for one code.
   * @param consoleFallback True to print a fixed warning if the diagnostic handler throws.
   */
  constructor(
    private handler?: DiagnosticHandler,
    private throttleMs = DIAGNOSTIC_THROTTLE_MS,
    private consoleFallback = false,
  ) {}

  /**
   * Changes the report interval and the console fallback rule.
   * @param throttleMs Minimum wait between reports of one code, in milliseconds.
   * @param consoleFallback True to print a fixed warning if the handler throws.
   */
  setPolicy(throttleMs: number, consoleFallback: boolean): void {
    this.throttleMs = throttleMs;
    this.consoleFallback = consoleFallback;
  }

  /**
   * Replaces or removes the active diagnostic event handler.
   * @param handler New diagnostic event handler.
   */
  setHandler(handler?: DiagnosticHandler): void {
    this.handler = handler;
  }

  /**
   * Increments the count for a code without calling the handler.
   * @param code Diagnostic code to increment.
   * @param by Amount to add.
   * @returns New total for the code.
   */
  count(code: DiagnosticCode, by = 1): number {
    const total = (this.counters.get(code) ?? 0) + by;
    this.counters.set(code, total);
    return total;
  }

  /**
   * Bumps the counter for the code and, once the throttle window has passed, sends the event
   * to the handler. Never throws.
   * @param code Diagnostic code.
   * @param message Event description.
   * @param detail Optional structured metadata.
   * @param cause Caught error instance or reason.
   * @returns False if the throttle dropped the event.
   */
  report(
    code: DiagnosticCode,
    message: string,
    detail?: Record<string, unknown>,
    cause?: unknown,
  ): boolean {
    const count = this.count(code);
    const now = Date.now();
    const last = this.lastEmitted.get(code) ?? 0;
    if (now - last < this.throttleMs) {
      return false;
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
      return true;
    }
    try {
      // Console capture skips anything the handler logs inside this scope. Without the scope,
      // the line becomes a record, and a failed send of that record raises a new diagnostic.
      runAsLibraryConsole(() => {
        handler(event);
      });
    } catch (_handlerError) {
      // Bump the counter directly. Calling report() here would recurse when the handler throws.
      this.count("handler.threw");
      if (this.consoleFallback && typeof console !== "undefined") {
        // Console capture skips calls made in this scope.
        runAsLibraryConsole(() => {
          // eslint-disable-next-line no-console -- Fallback sink when diagnostic handler throws.
          console.warn(`${LIBRARY_LOG_PREFIX} The onDiagnostic handler threw an error.`);
        });
      }
    }

    return true;
  }

  /**
   * Runs a synchronous function and reports anything it throws to diagnostics.
   * @param code Diagnostic code to report on throw.
   * @param message ASD-STE100 sentence that states the failure. The handler receives it as the
   *   event message.
   * @param fn Function to run.
   * @returns The function's return value, or undefined if it threw.
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
   * Runs an asynchronous function and reports a rejected promise to diagnostics.
   * @param code Diagnostic code to report on rejection.
   * @param message ASD-STE100 sentence that states the failure. The handler receives it as the
   *   event message.
   * @param fn Async function to run.
   * @returns Promise that resolves to the return value, or to undefined on rejection.
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
   * Returns a copy of the cumulative diagnostic counts since initialization.
   * @returns Map of diagnostic codes to occurrence counts.
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}
