// src/core/diagnostics.ts
//
// The internal error channel. Every catch block in this library reports here,
// so a fault inside the logger does not become silence in the consumer's
// application. Counters work with no handler set, so `snapshot()` answers
// "what am I not seeing".
//
// Emission is capped at one event per code per window: a broken render loop
// produces ten thousand identical errors a second, and a handler called that
// often is itself the outage. Counting is never throttled, so a throttled code
// still reports its true total on the next event through and in `snapshot()`.

import { DIAGNOSTIC_THROTTLE_MS, LIBRARY_LOG_PREFIX } from "../constants";

/**
 * Every fault this library can report. Closed rather than free-form: consumers
 * alert on these codes, and a typo would be an alert that never fires.
 */
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
  | "openfin.unavailable"
  | "handler.threw";

/** One fault, as it reaches the consumer's handler. */
export interface DiagnosticEvent {
  /** Which fault, from the closed set above. Alert on this, not on the message. */
  code: DiagnosticCode;
  /** Human-readable detail. Free-form, and it may change between versions. */
  message: string;
  /** Structured context, where there is any worth attaching. */
  detail?: Record<string, unknown>;
  /** The error or rejected value behind this, when one exists. */
  cause?: unknown;
  /** epoch ms */
  at: number;
  /** how many times this code has fired since startup, including throttled ones */
  count: number;
}

/**
 * What a consumer passes as `onDiagnostic`. It must not throw, and it is not trusted to keep that
 * promise.
 */
export type DiagnosticHandler = (event: DiagnosticEvent) => void;

/**
 * The internal error channel. Two rules:
 *   1. Nothing in this library uses a bare `catch {}`. Everything reports here.
 *   2. Reporting must never throw, including when the consumer's handler throws.
 */
export class Diagnostics {
  private readonly counters = new Map<DiagnosticCode, number>();
  private readonly lastEmitted = new Map<DiagnosticCode, number>();

  /**
   * Usable with no handler at all, which is what makes the counters work before a consumer
   * configures anything.
   */
  constructor(
    private handler?: DiagnosticHandler,
    /** per code, at most one emission in this window. Counting is never throttled. */
    private readonly throttleMs = DIAGNOSTIC_THROTTLE_MS,
  ) {}

  /** Swap the consumer's handler, or drop it by passing nothing. Called on every reconfigure. */
  setHandler(handler?: DiagnosticHandler): void {
    this.handler = handler;
  }

  /**
   * Increment the counter without emitting. For hot paths such as sampling
   * drops. Returns the new running total for this code, which is what
   * `report()` puts on the event.
   */
  count(code: DiagnosticCode, by = 1): number {
    const total = (this.counters.get(code) ?? 0) + by;
    this.counters.set(code, total);
    return total;
  }

  /**
   * Count this fault and, unless the code is inside its throttle window, hand
   * it to the consumer's handler.
   *
   * This is the one method every catch block in the library calls. It never
   * throws, including when the handler does.
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
      // The one catch that counts instead of calling report(): report() is what
      // called the handler, so reporting here would recurse until the stack ran out.
      this.count("handler.threw");
      // Not every context has a console.
      if (typeof console !== "undefined") {
        // eslint-disable-next-line no-console -- last-resort sink: reporting a throwing diagnostic handler would call it again and recurse
        console.warn(`${LIBRARY_LOG_PREFIX} onDiagnostic handler threw`, handlerError);
      }
    }
  }

  /**
   * Run `fn`, reporting instead of throwing. Use at every boundary where a
   * platform API might not exist or might be blocked by a sandbox.
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
   * As `guard`, for a boundary that returns a promise. A rejection reports rather than escaping as
   * an unhandled one.
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

  /** Counts since startup. Emit this periodically as a metric to answer "what am I not seeing". */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /**
   * Forget every count and every throttle window, so the next report emits immediately. Mostly a
   * test seam.
   */
  reset(): void {
    this.counters.clear();
    this.lastEmitted.clear();
  }
}
