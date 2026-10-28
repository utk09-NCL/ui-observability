// src/capture/web-vitals.ts
//
// Captures browser navigation timing and Core Web Vitals metrics through an optional peer.

import type { WebVitalsMetric, WebVitalsModule, WebVitalsReporter } from "../models/config";
import type { Capture, CaptureContext } from "./types";

/** Captures browser navigation timing benchmarks and Core Web Vitals. */
export class WebVitalsCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "web-vitals";

  /** Prevents duplicate listener registration. */
  private installed = false;

  /**
   * @param ctx Capture context containing configuration, diagnostics, and logger.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Reports navigation timing and starts to load web-vitals. */
  install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;

    this.reportNavigationTiming();

    if (this.ctx.once.webVitals) {
      return;
    }

    // Do not import the peer by name. The Vite dev server fails if the peer is not installed.
    // Do not set `once` here. A later configure() call with a loader must subscribe.
    const loader = this.ctx.config.capture.webVitalsLoader;
    if (!loader) {
      this.ctx.diagnostics.report(
        "config.invalid",
        "capture.webVitals needs capture.webVitalsLoader. LCP, CLS and INP are off. Navigation timing continues.",
      );
      return;
    }

    // Set the flag after a successful load, not before. A failed load then gets a new
    // attempt on a later install.
    void this.loadWebVitals(loader);
  }

  /**
   * Marks the module as uninstalled. The web-vitals reporters stay subscribed
   * because the package has no unsubscribe. `ctx.once` prevents a second set.
   */
  uninstall(): void {
    this.installed = false;
  }

  /**
   * Loads the web-vitals module and registers metric reporters.
   * @param loader Loader that the consumer supplies.
   */
  private async loadWebVitals(loader: () => Promise<WebVitalsModule>): Promise<void> {
    const module = await this.ctx.diagnostics.guardAsync(
      "capture.install_failed",
      "The library could not load web-vitals.",
      loader,
    );

    if (!module) {
      this.ctx.diagnostics.report(
        "capture.install_failed",
        "The web-vitals module is not available. LCP, CLS and INP are off. Navigation timing continues.",
      );
      return;
    }

    // Two installs in one turn both load the module. Only the first subscribes.
    // web-vitals has no unsubscribe, and a second set reports each metric two times.
    if (this.ctx.once.webVitals) {
      return;
    }
    this.ctx.once.webVitals = true;

    const send =
      (name: string, unit: string): WebVitalsReporter =>
      (metric: WebVitalsMetric): void => {
        this.ctx.logger.logMetric(
          `web_vitals.${name}`,
          // Keep three decimals. CLS is a small fraction. An integer value
          // reports each layout shift as zero.
          Math.round(metric.value * 1000) / 1000,
          unit,
          "gauge",
          { "metric.rating": metric.rating, "metric.id": metric.id },
        );
      };

    module.onLCP(send("lcp", "ms"));
    module.onCLS(send("cls", "1"));
    module.onINP(send("inp", "ms"));
    module.onFCP(send("fcp", "ms"));
    module.onTTFB(send("ttfb", "ms"));
  }

  /** Extracts and logs PerformanceNavigationTiming benchmarks one time for each document. */
  private reportNavigationTiming(): void {
    // The entry describes the one navigation of this document. A second report after a
    // reconfigure duplicates the seven metrics.
    if (this.ctx.once.navigationTiming) {
      return;
    }
    this.ctx.once.navigationTiming = true;

    this.ctx.diagnostics.guard(
      "capture.install_failed",
      "The library could not read the navigation timing.",
      () => {
        const nav = performance.getEntriesByType("navigation")[0] as
          PerformanceNavigationTiming | undefined;
        if (!nav) {
          return;
        }

        const metrics: Record<string, number> = {
          "navigation.dns_ms": nav.domainLookupEnd - nav.domainLookupStart,
          "navigation.tcp_ms": nav.connectEnd - nav.connectStart,
          "navigation.ttfb_ms": nav.responseStart - nav.requestStart,
          "navigation.response_ms": nav.responseEnd - nav.responseStart,
          "navigation.dom_interactive_ms": nav.domInteractive,
          "navigation.dom_complete_ms": nav.domComplete,
          "navigation.load_ms": nav.loadEventEnd,
        };

        for (const [name, value] of Object.entries(metrics)) {
          // Filters unrecorded or negative timings to avoid false zero readings.
          if (Number.isFinite(value) && value >= 0) {
            this.ctx.logger.logMetric(name, Math.round(value), "ms", "gauge", {
              "navigation.type": nav.type,
            });
          }
        }
      },
    );
  }
}
