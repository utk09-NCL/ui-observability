// e2e/collector/main.ts
//
// Fixture page of tools/check-collector.mjs. It sends one log, one counter point and one span
// through the library's public entry point to the collector that the check started.

import { configure, counter, flush, getLogger, startMeasure } from "../../src/index";

/** One run's settings. The check passes every value in, so it asserts on the same values. */
interface RunOptions {
  /** Base URL of the collector's OTLP/HTTP receiver. */
  collectorUrl: string;
  /** Reported as `service.name` on each signal. */
  serviceName: string;
  /** "none" sends plain JSON. "gzip" compresses a body above the library's threshold. */
  compression: "gzip" | "none";
  /** Value of the `check.run` attribute on each signal, so the check can tell two runs apart. */
  runId: string;
  /** Body of the log record. */
  logBody: string;
  /** Name of the counter. */
  counterName: string;
  /** Name of the measure, which the library sends as a span. */
  spanName: string;
}

/** What the library lost or reported during one run. Both lists are empty on a clean run. */
interface RunReport {
  /** One line for each onDrop summary. */
  drops: string[];
  /** One line for each diagnostic event. */
  diagnostics: string[];
}

/**
 * Sends one log, one counter point and one span to the collector, then waits for the answers.
 * @param options The run's settings.
 * @returns What the library lost or reported.
 */
async function sendSignals(options: RunOptions): Promise<RunReport> {
  const report: RunReport = { drops: [], diagnostics: [] };

  configure({
    endpoint: `${options.collectorUrl}/v1/logs`,
    metricsEndpoint: `${options.collectorUrl}/v1/metrics`,
    tracesEndpoint: `${options.collectorUrl}/v1/traces`,
    serializer: "otlp",
    serviceName: options.serviceName,
    compression: options.compression,
    // Nothing is stored, so the second run can't send a batch that the first run left behind.
    storage: { backend: "none" },
    identity: "memory",
    // The page has no frame and no worker, and an open bus reports its role as a diagnostic.
    bus: { mode: "off" },
    onDrop: (summary) => {
      report.drops.push(`${summary.reason}: ${String(summary.records)} records`);
    },
    onDiagnostic: (event) => {
      report.diagnostics.push(`${event.code}: ${event.message}`);
    },
  });

  const attributes = { "check.run": options.runId };

  getLogger("collector.check").info(options.logBody, attributes);
  counter(options.counterName).add(1, attributes);
  startMeasure(options.spanName, attributes).end();

  await flush();

  return report;
}

// The check calls this through Playwright's page.evaluate(), so it has to be a global.
Object.assign(globalThis, { sendSignals });
