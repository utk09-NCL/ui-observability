// src/capture/web-vitals.ts
//
// Captures browser navigation timing and Core Web Vitals metrics via optional peer.

import type { WebVitalsMetric, WebVitalsModule, WebVitalsReporter } from "../models/config";
import type { Capture, CaptureContext } from "./types";

/**
 * Dynamically loads the optional web-vitals peer dependency.
 * Dynamic specifier prevents bundlers from failing statically when peer is uninstalled.
 * @returns Promise resolving to the web-vitals module.
 */
function defaultLoader(): Promise<WebVitalsModule> {
  const specifier = "web-vitals";
  return import(/* @vite-ignore */ specifier) as Promise<WebVitalsModule>;
}

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

  /** Reports navigation benchmarks and initiates web-vitals loading. */
  install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;

    this.reportNavigationTiming();
    void this.loadWebVitals();
  }

  /** Marks module uninstalled. */
  uninstall(): void {
    this.installed = false;
  }

  /** Loads the web-vitals module and registers metric reporters. */
  private async loadWebVitals(): Promise<void> {
    const loader = this.ctx.config.capture.webVitalsLoader ?? defaultLoader;
    const module = await this.ctx.diagnostics.guardAsync(
      "capture.install_failed",
      "loading web-vitals",
      loader,
    );

    if (!module) {
      this.ctx.diagnostics.report(
        "capture.install_failed",
        "web-vitals is not available, so LCP, CLS and INP are unavailable. Navigation timing still works.",
      );
      return;
    }

    const send =
      (name: string, unit: string): WebVitalsReporter =>
      (metric: WebVitalsMetric): void => {
        this.ctx.logger.logMetric(
          `web_vitals.${name}`,
          // Three decimals: CLS is a small fraction, and rounding it to an
          // integer reports every layout shift as zero.
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

  /** Extracts and logs PerformanceNavigationTiming benchmarks. */
  private reportNavigationTiming(): void {
    this.ctx.diagnostics.guard("capture.install_failed", "reading navigation timing", () => {
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
    });
  }
}
