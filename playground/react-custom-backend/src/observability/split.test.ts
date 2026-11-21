import { describe, expect, it, vi } from "vitest";
import {
  configure,
  flush,
  getLogger,
  shutdown,
  type DropSummary,
  type TransportRequest,
  type TransportResponse,
} from "@utk09/ui-observability";

// A backend that answers 413 for a request that has more records than it takes. The uilogs
// server does this above 500 records. The spec uses small numbers so that it runs fast.
const SERVER_MAX_RECORDS = 20;
const RECORDS = 40;

interface Run {
  /** Bodies of the records that the backend accepted. */
  accepted: string[];
  /** Number of records in each request, in the order of the requests. */
  sizes: number[];
  drops: DropSummary[];
}

async function logThroughBackend(backend: "memory" | "none"): Promise<Run> {
  await shutdown();
  const run: Run = { accepted: [], sizes: [], drops: [] };
  configure({
    serviceName: "react-custom-backend",
    transport: (request: TransportRequest): Promise<TransportResponse> => {
      run.sizes.push(request.records.length);
      if (request.records.length > SERVER_MAX_RECORDS) {
        return Promise.resolve({ status: 413 });
      }

      run.accepted.push(...request.records.map((record) => record.body));
      return Promise.resolve({ status: 200 });
    },
    storage: { backend },
    bus: { mode: "off" },
    identity: "memory",
    batching: { logBatchSize: RECORDS, logFlushIntervalMs: 100 },
    // The halves wait for a retry, and the default delays are in seconds.
    delivery: { retryBaseDelayMs: 50, retryMaxDelayMs: 100 },
    onDrop: (summary) => run.drops.push(summary),
  });

  const log = getLogger("split.spec");
  for (let index = 0; index < RECORDS; index += 1) {
    log.info(`record ${String(index)}`);
  }
  await flush();

  return run;
}

const sent = (run: Run): string[] => run.accepted.filter((body) => body.startsWith("record "));

describe("a backend that answers 413 for a request that is too large", () => {
  it("makes the library split the batch, so that every record arrives", async () => {
    const run = await logThroughBackend("memory");

    await vi.waitFor(() => {
      expect(sent(run)).toHaveLength(RECORDS);
    });
    // One request of 40 records, then its two halves.
    expect(run.sizes.slice(0, 3)).toEqual([RECORDS, RECORDS / 2, RECORDS / 2]);
    expect(run.drops).toEqual([]);
  });

  it("loses the batch when storage is none, because the halves have nowhere to wait", async () => {
    const run = await logThroughBackend("none");
    // The retry delay is 50 ms. Wait longer, so that a send of the halves would have happened.
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    expect(sent(run)).toEqual([]);
    expect(run.drops.map((drop) => drop.reason)).toEqual(["not_stored", "not_stored"]);
    expect(run.drops.reduce((total, drop) => total + drop.records, 0)).toBe(RECORDS);
  });
});
