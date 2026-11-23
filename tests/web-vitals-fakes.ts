// tests/web-vitals-fakes.ts
//
// A fake of the web-vitals package. The real package has no unsubscribe, and it sends each
// metric report to every reporter that subscribed, so the fake does the same.

import type { WebVitalsMetric, WebVitalsModule } from "../src/models/config";

/** The metrics that the capture subscribes to. */
type VitalName = "lcp" | "cls" | "inp" | "fcp" | "ttfb";

/** A fake web-vitals module, a way to fire a metric and a count of the subscriptions. */
export interface FakeVitals {
  /** The loader to give `capture.webVitals.loader`. */
  loader: () => Promise<WebVitalsModule>;
  /**
   * Reports one metric to every reporter that subscribed to it.
   * @param name The metric.
   * @param value The metric value.
   */
  fire: (name: VitalName, value: number) => void;
  /** Counts the reporters that subscribed, over all five metrics. */
  subscriptions: () => number;
}

/**
 * Builds a fake web-vitals module.
 * @returns The loader, `fire()` and the subscription count.
 */
export function fakeVitals(): FakeVitals {
  const reporters: Record<VitalName, ((metric: WebVitalsMetric) => void)[]> = {
    lcp: [],
    cls: [],
    inp: [],
    fcp: [],
    ttfb: [],
  };
  const subscribe = (name: VitalName) => (report: (metric: WebVitalsMetric) => void) => {
    reporters[name].push(report);
  };

  return {
    loader: () =>
      Promise.resolve({
        onLCP: subscribe("lcp"),
        onCLS: subscribe("cls"),
        onINP: subscribe("inp"),
        onFCP: subscribe("fcp"),
        onTTFB: subscribe("ttfb"),
      }),
    fire: (name, value) => {
      for (const report of reporters[name]) {
        report({ value, id: `${name}-id`, rating: "needs-improvement" });
      }
    },
    subscriptions: () => Object.values(reporters).flat().length,
  };
}
