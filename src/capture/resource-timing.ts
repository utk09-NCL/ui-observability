import { RESOURCE_SLOW_MS } from "../constants";
import type { InstrumentDef } from "../models/metric";
import { recordedUrl } from "../utils/platform";
import { allowInWindow, type StormWindow } from "./storm";
import { type Capture, type CaptureContext, matchesAny } from "./types";

/** Resource durations in milliseconds. URLs and paths do not create metric series. */
const RESOURCE_DURATION: InstrumentDef = {
  name: "ui.resource.duration",
  kind: "histogram",
  unit: "ms",
  boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
};

/** Records bounded resource timings and slow resource events. */
export class ResourceTimingCapture implements Capture {
  readonly name = "resourceTiming";

  private observer: PerformanceObserver | undefined;

  private readonly window: StormWindow = { start: 0, count: 0 };

  constructor(private readonly ctx: CaptureContext) {}

  /** Reads buffered resources only at the first install in this document. */
  install(): void {
    if (this.observer) {
      return;
    }

    const supported: readonly string[] | undefined =
      typeof PerformanceObserver === "undefined"
        ? undefined
        : PerformanceObserver.supportedEntryTypes;
    if (!supported?.includes("resource")) {
      this.ctx.diagnostics.report(
        "capture.install_failed",
        "The browser does not report resource timing entries. The resource timing capture is off.",
      );
      return;
    }

    const first = !this.ctx.once.resourceTiming;
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.record(entry as PerformanceResourceTiming);
      }
    });
    this.observer.observe({ type: "resource", buffered: first });
    this.ctx.once.resourceTiming = true;
  }

  /** Disconnects the observer. */
  uninstall(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  private record(entry: PerformanceResourceTiming): void {
    if (!this.observer || this.ctx.isActive?.() === false) {
      return;
    }

    this.ctx.diagnostics.guard(
      "capture.record_failed",
      "The library could not record a resource timing entry.",
      () => {
        const { capture, capturePolicy } = this.ctx.config;
        const url = new URL(entry.name, location.href);
        const endpoints = [
          this.ctx.config.endpoint,
          this.ctx.config.metricsEndpoint,
          this.ctx.config.tracesEndpoint,
        ];
        if (
          matchesAny(entry.name, capture.ignoreUrls) ||
          endpoints.some(
            (endpoint) => endpoint && url.href.startsWith(new URL(endpoint, location.href).href),
          )
        ) {
          return;
        }
        if (
          !Number.isFinite(entry.duration) ||
          entry.duration < 0 ||
          !["http:", "https:"].includes(url.protocol)
        ) {
          return;
        }
        if (
          !allowInWindow(
            this.window,
            capturePolicy.resourcesPerWindow,
            this.ctx.diagnostics,
            "resource entries",
            capturePolicy.windowMs,
          )
        ) {
          return;
        }

        const attributes = {
          "resource.initiator_type": entry.initiatorType,
          "server.address": url.hostname,
        };
        this.ctx.recordMetric(RESOURCE_DURATION, entry.duration, attributes);

        const slowMs =
          typeof capture.resourceTiming === "object"
            ? (capture.resourceTiming.slowMs ?? RESOURCE_SLOW_MS)
            : RESOURCE_SLOW_MS;
        if (slowMs > 0 && entry.duration >= slowMs) {
          this.ctx.logger.logEvent("ui.resource.slow", {
            ...attributes,
            "resource.duration_ms": entry.duration,
            "url.full": recordedUrl(
              entry.name,
              capture.fullUrls,
              capture.urlTransform,
              this.ctx.diagnostics,
            ),
          });
        }
      },
    );
  }
}
