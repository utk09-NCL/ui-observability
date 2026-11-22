// src/capture/web-vitals.ts
//
// Captures browser navigation timing and Core Web Vitals metrics through an optional peer.

import type { WebVitalsMetric, WebVitalsModule, WebVitalsReporter } from "../models/config";
import type { Capture, CaptureContext } from "./types";

/** True while the browser prerenders the page. The DOM typings don't declare the field yet. */
const prerendering = (): boolean => (document as { prerendering?: boolean }).prerendering === true;

/** Captures browser navigation timing and Core Web Vitals. */
export class WebVitalsCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "web-vitals";

  /** Prevents duplicate listener registration. */
  private installed = false;

  /** Navigation metrics already logged, so the early and the late read never repeat one. */
  private readonly logged = new Set<string>();

  /**
   * @param ctx Capture context: configuration, diagnostics and logger.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Reports navigation timing and starts loading web-vitals. */
  install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;
    // An earlier install's reporters may already be subscribed, and this turns them on again.
    this.ctx.once.webVitalsOn = true;

    this.reportNavigationTiming();

    if (this.ctx.once.webVitals) {
      return;
    }

    // Don't import the peer by name, because the Vite dev server fails if it isn't installed.
    // Don't set `once` here either. A later configure() call with a loader must still subscribe.
    const { webVitals } = this.ctx.config.capture;
    const loader = typeof webVitals === "object" ? webVitals.loader : undefined;
    if (!loader) {
      this.ctx.diagnostics.report(
        "config.invalid",
        "capture.webVitals needs capture.webVitals.loader. LCP, CLS and INP are off. Navigation timing continues.",
      );
      return;
    }

    // Set the flag after a successful load, not before, so a failed load gets another
    // attempt on a later install.
    void this.loadWebVitals(loader);
  }

  /**
   * Marks the module as uninstalled. The web-vitals reporters stay subscribed
   * because the package has no unsubscribe, and `ctx.once` prevents a second set.
   * They record nothing until the next install sets `ctx.once.webVitalsOn` again.
   */
  uninstall(): void {
    this.installed = false;
    this.ctx.once.webVitalsOn = false;
  }

  /**
   * Loads the web-vitals module and registers the metric reporters.
   * @param loader The loader the consumer supplies.
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

    // Two installs in one turn both load the module, but only the first subscribes.
    // web-vitals has no unsubscribe, and a second set would report every metric twice.
    if (this.ctx.once.webVitals) {
      return;
    }
    this.ctx.once.webVitals = true;

    const send =
      (name: string, unit: string): WebVitalsReporter =>
      (metric: WebVitalsMetric): void => {
        // INP and CLS report at the page hide, often after the app switched the capture off.
        if (!this.ctx.once.webVitalsOn) {
          return;
        }

        this.ctx.logger.logMetric(
          `web_vitals.${name}`,
          // Keep three decimals. CLS is a small fraction, and rounding it to an integer
          // would report every layout shift as zero.
          Math.round(metric.value * 1000) / 1000,
          unit,
          "gauge",
          { "metric.rating": metric.rating },
          // The id is new on each page load, so as a point attribute it would start a new
          // series for every visit. The log record keeps it to identify the report.
          { "metric.id": metric.id },
        );
      };

    module.onLCP(send("lcp", "ms"));
    module.onCLS(send("cls", "1"));
    module.onINP(send("inp", "ms"));
    module.onFCP(send("fcp", "ms"));
    module.onTTFB(send("ttfb", "ms"));
  }

  /** Logs the navigation timing metrics, once per document and only after the load event. */
  private reportNavigationTiming(): void {
    // The entry describes this document's one navigation, so a second report after a
    // reconfigure would duplicate the seven metrics.
    if (this.ctx.once.navigationTiming) {
      return;
    }
    this.ctx.once.navigationTiming = true;

    this.guardNavigation(() => {
      const nav = performance.getEntriesByType("navigation")[0] as
        PerformanceNavigationTiming | undefined;
      if (!nav) {
        return;
      }

      const log = (): void => {
        this.guardNavigation(() => {
          this.logNavigation(nav);
        });
      };

      // A prerendered page has no activationStart until the user opens it, and a page nobody
      // opens must report nothing. So the full report waits for the activation.
      const whenOpened = (): void => {
        if (prerendering()) {
          document.addEventListener("prerenderingchange", log, { once: true });
        } else {
          log();
        }
      };

      if (nav.loadEventEnd > 0) {
        whenOpened();
        return;
      }

      // An app usually starts the library before the load event, when domComplete and
      // loadEventEnd are still 0. Read one task after load, because the browser sets
      // loadEventEnd only once the load handlers have returned. The entry is live.
      const later = (): void => {
        setTimeout(() => {
          document.removeEventListener("visibilitychange", early);
          whenOpened();
        }, 0);
      };

      // A user who leaves a slow page before it has loaded would otherwise report nothing,
      // and the slowest loads would be missing from the data. Log what is ready by then.
      // A page that is still prerendering is hidden too, but nobody has left it.
      const early = (): void => {
        if (document.visibilityState === "hidden" && !prerendering()) {
          log();
        }
      };
      document.addEventListener("visibilitychange", early);

      // Inside a load handler the state is already "complete" and no second load event comes.
      if (document.readyState === "complete") {
        later();
      } else {
        addEventListener("load", later, { once: true });
      }
    });
  }

  /**
   * Runs one step of the navigation timing read. The browser calls the late steps directly,
   * so anything they throw would be an uncaught error on the page.
   * @param step The step to run.
   */
  private guardNavigation(step: () => void): void {
    this.ctx.diagnostics.guard(
      "capture.install_failed",
      "The library could not read the navigation timing.",
      step,
    );
  }

  /**
   * Logs every navigation metric that is ready and hasn't been logged yet.
   * @param nav The document's navigation entry.
   */
  private logNavigation(nav: PerformanceNavigationTiming): void {
    // On a prerendered page the entry's clock starts long before the user sees anything.
    // Count the milestones from the activation and never below 0, as the web-vitals package
    // does for its own metrics. Older browsers have no activationStart.
    const opened = (nav as { activationStart?: number }).activationStart ?? 0;
    // 0 means "not reached yet", and NaN makes the check below skip it.
    const since = (time: number): number => (time > 0 ? Math.max(time - opened, 0) : NaN);
    const type = opened > 0 ? "prerender" : nav.type;
    const metrics: Record<string, number> = {
      "navigation.dns_ms": nav.domainLookupEnd - nav.domainLookupStart,
      "navigation.tcp_ms": nav.connectEnd - nav.connectStart,
      "navigation.ttfb_ms": nav.responseStart - nav.requestStart,
      "navigation.response_ms": nav.responseEnd - nav.responseStart,
      "navigation.dom_interactive_ms": since(nav.domInteractive),
      "navigation.dom_complete_ms": since(nav.domComplete),
      "navigation.load_ms": since(nav.loadEventEnd),
    };

    for (const [name, value] of Object.entries(metrics)) {
      // Skip timings that are missing or negative, so they don't show up as false zeros.
      if (Number.isFinite(value) && value >= 0 && !this.logged.has(name)) {
        this.logged.add(name);
        this.ctx.logger.logMetric(name, Math.round(value), "ms", "gauge", {
          "navigation.type": type,
        });
      }
    }
  }
}
