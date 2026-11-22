// e2e/web-vitals.e2e.ts
//
// The web-vitals capture with the real optional peer in each engine. A unit test fakes the
// package, so only a browser shows which metrics the browser measures and whether each one
// reaches the metrics endpoint with its unit and rating.

import { expect, type Page, test } from "@playwright/test";
import {
  INGEST_ORIGIN,
  LOGS_ENDPOINT,
  PAGE_PATH,
  readReceived,
  resetIngest,
  stopLibrary,
} from "./fixtures/ingest";

/** Where the page under test posts its metric points. */
const METRICS_ENDPOINT = `${INGEST_ORIGIN}/v1/metrics`;

/** The navigation timing gauges that the capture logs after the load event. */
const NAVIGATION_GAUGES = [
  "navigation.dns_ms",
  "navigation.tcp_ms",
  "navigation.ttfb_ms",
  "navigation.response_ms",
  "navigation.dom_interactive_ms",
  "navigation.dom_complete_ms",
  "navigation.load_ms",
];

/** One OTLP attribute of a data point, with only the variant that the test reads. */
interface Attribute {
  key: string;
  value: { stringValue?: string };
}

/** One gauge point with the fields that the test reads. */
interface Point {
  name: string;
  unit: string;
  value: number;
  attributes: Record<string, string | undefined>;
  exit: string | null;
}

/** The OTLP metrics body, with only the fields that the test reads. */
interface MetricsPayload {
  resourceMetrics?: {
    scopeMetrics?: {
      metrics?: {
        name: string;
        unit?: string;
        gauge?: { dataPoints?: { asDouble?: number; asInt?: string; attributes?: Attribute[] }[] };
      }[];
    }[];
  }[];
}

test.beforeEach(async () => {
  await resetIngest();
});

test.afterEach(async ({ page }) => {
  await stopLibrary(page);
});

/** Returns every gauge point that the server kept, in the order it got them. */
async function readPoints(): Promise<Point[]> {
  const received = await readReceived();
  const points: Point[] = [];

  for (const request of received["/v1/metrics"]) {
    const payload = request.payload as MetricsPayload;
    for (const resourceMetric of payload.resourceMetrics ?? []) {
      for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
        for (const metric of scopeMetric.metrics ?? []) {
          for (const point of metric.gauge?.dataPoints ?? []) {
            points.push({
              name: metric.name,
              unit: metric.unit ?? "",
              value: point.asDouble ?? Number(point.asInt),
              attributes: Object.fromEntries(
                (point.attributes ?? []).map((attribute) => [
                  attribute.key,
                  attribute.value.stringValue,
                ]),
              ),
              exit: request.exit,
            });
          }
        }
      }
    }
  }

  return points;
}

/** Returns the first point with the given name, or undefined. */
async function readPoint(name: string): Promise<Point | undefined> {
  return (await readPoints()).find((point) => point.name === name);
}

/**
 * Loads the page with a text block, so there is a paint to measure, and starts the capture with
 * the real web-vitals package. The test's own reporters see what the package reports.
 */
async function startCapture(page: Page): Promise<void> {
  await page.goto(PAGE_PATH);

  // The content exists before the capture starts, so the first paint has something to measure.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<h1 style="font-size:40px">Order ticket</h1>');
  });

  await page.evaluate(
    async ({ endpoint, metricsEndpoint }) => {
      // The page's own reports are the reference for what the package measured in this engine.
      const reported: Record<string, number> = {};
      (window as unknown as { reported: Record<string, number> }).reported = reported;

      // The browser emits an LCP candidate some frames after the paint, and a page that leaves
      // before that has nothing to report. The observer's replay of old entries closes the gap.
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          reported.lcpCandidate = entry.startTime;
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
      const vitals = await window.e2e.loadWebVitals();
      vitals.onFCP((metric) => {
        reported.fcp = metric.value;
      });
      vitals.onTTFB((metric) => {
        reported.ttfb = metric.value;
      });

      window.e2e.uiobs.configure({
        endpoint,
        metricsEndpoint,
        serviceName: "e2e-vitals",
        onDiagnostic: window.e2e.onDiagnostic,
        capture: { webVitals: { loader: window.e2e.loadWebVitals } },
      });
      await window.e2e.uiobs.flush();
    },
    { endpoint: LOGS_ENDPOINT, metricsEndpoint: METRICS_ENDPOINT },
  );
}

test("reports the navigation timing, TTFB and FCP of the real page", async ({ page }) => {
  await startCapture(page);

  // The gauges leave on the batch timer, so flush until the capture has logged each one.
  await expect
    .poll(async () => {
      await page.evaluate(() => window.e2e.uiobs.flush());
      const names = (await readPoints()).map((point) => point.name);
      return [...NAVIGATION_GAUGES, "web_vitals.ttfb", "web_vitals.fcp"].filter(
        (name) => !names.includes(name),
      );
    })
    .toEqual([]);

  for (const name of NAVIGATION_GAUGES) {
    const point = await readPoint(name);
    expect(point?.unit).toBe("ms");
    expect(point?.attributes["navigation.type"]).toBe("navigate");
    expect(point?.value).toBeGreaterThanOrEqual(0);
  }

  // The library logs what the package reported, rounded to three decimals.
  const reported = await page.evaluate(
    () => (window as unknown as { reported: Record<string, number> }).reported,
  );
  for (const metric of ["ttfb", "fcp"]) {
    const point = await readPoint(`web_vitals.${metric}`);
    expect(point?.unit).toBe("ms");
    expect(point?.attributes["metric.rating"]).toMatch(/^(good|needs-improvement|poor)$/);
    expect(point?.value).toBe(Math.round(reported[metric] * 1000) / 1000);
  }

  // The metric id changes on each page load, so a point never carries it.
  expect((await readPoint("web_vitals.fcp"))?.attributes).not.toHaveProperty("metric.id");

  // A failed load of the peer or of a capture would show as a diagnostic.
  const codes = await page.evaluate(() => window.e2e.diagnostics.map((event) => event.code));
  expect(codes).not.toContain("capture.install_failed");
  expect(codes).not.toContain("config.invalid");
});

test("delivers the final LCP when the page goes away", async ({ page }) => {
  await startCapture(page);

  // The package reports the final LCP at visibilitychange, and a real leave fires pagehide first.
  // Probe, 2026-11-22: Chromium and Firefox lose that report, and WebKit sends it.
  await page.waitForFunction(
    () => "lcpCandidate" in (window as unknown as { reported: Record<string, number> }).reported,
  );
  await page.goto("about:blank");

  await expect.poll(() => readPoint("web_vitals.lcp")).toBeDefined();
  const point = await readPoint("web_vitals.lcp");

  expect(point?.unit).toBe("ms");
  expect(point?.value).toBeGreaterThan(0);
  expect(point?.attributes["metric.rating"]).toMatch(/^(good|needs-improvement|poor)$/);
});

test("delivers the final INP and CLS when the page goes away", async ({ page }) => {
  await startCapture(page);

  // The click blocks the main thread for 120 ms, so it passes the package's 40 ms threshold for
  // an INP entry. The package reports INP and CLS at visibilitychange, after the exit flush.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<button id="buy">Buy</button>');
    document.getElementById("buy")?.addEventListener("click", () => {
      const end = performance.now() + 120;
      while (performance.now() < end) {
        // Blocks on purpose.
      }
    });
  });

  // A layout shift that no input caused, 600 ms after the page started, so CLS counts it.
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "120px";
    document.body.prepend(spacer);
  });
  await page.waitForTimeout(600);

  await page.click("#buy");
  await page.waitForFunction(
    () => "lcpCandidate" in (window as unknown as { reported: Record<string, number> }).reported,
  );
  const supported = await page.evaluate(() => PerformanceObserver.supportedEntryTypes);
  await page.goto("about:blank");

  // INP and CLS only exist when the engine has the entry type behind them.
  const expected = [
    ...(supported.includes("event") ? ["web_vitals.inp"] : []),
    ...(supported.includes("layout-shift") ? ["web_vitals.cls"] : []),
  ];
  await expect
    .poll(async () => {
      const names = (await readPoints()).map((point) => point.name);
      return expected.filter((name) => !names.includes(name));
    })
    .toEqual([]);
});
