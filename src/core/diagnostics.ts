// src/core/diagnostics.ts
//
// The internal error channel. Every catch block in this library reports into a
// Diagnostics instance, which is what keeps a fault inside the logger from
// turning into silence in the consumer's application. A consumer that never
// sets a handler still gets working counters, so `snapshot()` can answer the
// question "what am I not seeing".
//
// Why the throttle exists: a broken render loop can produce ten thousand
// identical errors a second, and a handler invoked ten thousand times a second
// is itself the outage. Emission is therefore capped at one event per code per
// window, while counting is never throttled, so a throttled code still reports
// its true total on the next event that gets through and in `snapshot()`.

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
  | "handler.threw";

export interface DiagnosticEvent {
  code: DiagnosticCode;
  message: string;
  detail?: Record<string, unknown>;
  cause?: unknown;
  /** epoch ms */
  at: number;
  /** how many times this code has fired since startup, including throttled ones */
  count: number;
}

export type DiagnosticHandler = (event: DiagnosticEvent) => void;

/**
 * The internal error channel. Two rules:
 *   1. Nothing in this library uses a bare `catch {}`. Everything reports here.
 *   2. Reporting must never throw, including when the consumer's handler throws.
 */
export class Diagnostics {
  private readonly counters = new Map<DiagnosticCode, number>();
  private readonly lastEmitted = new Map<DiagnosticCode, number>();

  constructor(
    private handler?: DiagnosticHandler,
    /** per code, at most one emission in this window. Counting is never throttled. */
    private readonly throttleMs = 1000,
  ) {}

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
      // The consumer's own handler threw. This is the single catch in the
      // library that counts instead of calling report(), because report() is
      // what just called the handler: reporting here would call it again and
      // recurse until the stack ran out.
      this.count("handler.threw");
      // Not every context this library runs in has a console, so it is checked
      // rather than assumed.
      if (typeof console !== "undefined") {
        // eslint-disable-next-line no-console -- last-resort sink for a consumer diagnostic handler that itself threw, since reporting it would call that same handler again and recurse
        console.warn("[ui-observability] onDiagnostic handler threw", handlerError);
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

  reset(): void {
    this.counters.clear();
    this.lastEmitted.clear();
  }
}
