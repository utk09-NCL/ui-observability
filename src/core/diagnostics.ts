// src/core/diagnostics.ts
//
// Internal telemetry error reporting, rate-limited emission, and cumulative event counters.

import { DIAGNOSTIC_THROTTLE_MS, LIBRARY_LOG_PREFIX } from "../constants";

/** Closed set of diagnostic event codes emitted by library subsystems. */
export type DiagnosticCode =
  | "config.invalid"
  | "config.reconfigured"
  | "record.sanitize_failed"
  | "record.truncated"
  | "record.dropped_by_level"
  | "record.dropped_by_sampling"
  | "record.dropped_by_redact"
  | "record.dropped_boot_buffer_full"
  | "record.dropped_pending_full"
  | "record.dropped_malformed"
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
  | "openfin.unavailable"
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
  /** Cumulative count of this code since startup, including rate-limited occurrences. */
  count: number;
}

/** Consumer callback for receiving rate-limited diagnostic events. */
export type DiagnosticHandler = (event: DiagnosticEvent) => void;

/** Internal error reporting channel with rate-limited dispatch and unthrottled counters. */
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
   * Increments the occurrence count for a code without triggering handler emission.
   * @param code Diagnostic code to increment.
   * @param by Increment delta.
   * @returns Updated cumulative total for the code.
   */
  count(code: DiagnosticCode, by = 1): number {
    const total = (this.counters.get(code) ?? 0) + by;
    this.counters.set(code, total);
    return total;
  }

  /**
   * Increments counter and dispatches event if outside the throttling window. Never throws.
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

    if (!this.handler) {
      return;
    }
    try {
      this.handler(event);
    } catch (handlerError) {
      // Increments counter without calling report() to avoid recursion on handler faults.
      this.count("handler.threw");
      if (typeof console !== "undefined") {
        // eslint-disable-next-line no-console -- Fallback sink when diagnostic handler throws.
        console.warn(`${LIBRARY_LOG_PREFIX} onDiagnostic handler threw`, handlerError);
      }
    }
  }

  /**
   * Executes a synchronous function and reports any thrown error to diagnostics.
   * @param code Diagnostic code to report on throw.
   * @param message Error description.
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
   * @param message Error description.
   * @param fn Async function to execute.
   * @returns Promise resolving to the return value, or undefined on rejection.
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

  /** Clears all counters and throttling history. */
  reset(): void {
    this.counters.clear();
    this.lastEmitted.clear();
  }
}
