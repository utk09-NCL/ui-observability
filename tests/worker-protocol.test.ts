import { describe, expect, it } from "vitest";
import {
  TELEMETRY_SDK_VERSION,
  TRANSPORT_WORKER_PROTOCOL,
  TRANSPORT_WORKER_TYPE,
} from "../src/constants";
import {
  isWorkerJob,
  isWorkerMessage,
  isWorkerResult,
  workerMessage,
} from "../src/transport/worker-protocol";

import { workerJob } from "./worker-fakes";

describe("Transport worker protocol", () => {
  it("uses a fixed protocol and the exact library version", () => {
    const message = workerMessage(TRANSPORT_WORKER_TYPE.connect);
    expect(message).toEqual({
      p: TRANSPORT_WORKER_PROTOCOL,
      v: TELEMETRY_SDK_VERSION,
      t: TRANSPORT_WORKER_TYPE.connect,
    });
    expect(isWorkerMessage(message)).toBe(true);
    expect(workerMessage(TRANSPORT_WORKER_TYPE.send, { id: 1 }).id).toBe(1);
    expect(isWorkerMessage(null)).toBe(false);
    expect(isWorkerMessage({ ...message, p: "other" })).toBe(false);
    expect(isWorkerMessage({ ...message, v: "other" })).toBe(false);
  });

  it("accepts an HTTP endpoint scheme in any letter case", () => {
    expect(isWorkerJob({ ...workerJob(), endpoint: "HTTPS://ingest.example/logs" })).toBe(true);
  });

  it.each(["serialize", "network", "timeout", "protocol"])(
    "accepts the failure code %s",
    (failure) => {
      expect(isWorkerResult({ failure })).toBe(true);
    },
  );

  it("accepts nullable response headers and finite hints", () => {
    for (const response of [
      { status: 204 },
      { status: 429, retryAfterMs: 1000, maxBytes: 20, sampling: null, date: null },
      { status: 200, sampling: "rules", date: "date", compressionFailed: false },
    ]) {
      expect(isWorkerResult(response)).toBe(true);
    }
  });

  it.each(
    [
      null,
      { failure: "other" },
      { status: "200" },
      { status: 200.5 },
      { status: 99 },
      { status: 600 },
      { status: 200, retryAfterMs: "1" },
      { status: 200, retryAfterMs: Infinity },
      { status: 200, retryAfterMs: -1 },
      { status: 200, maxBytes: NaN },
      { status: 200, sampling: 1 },
      { status: 200, date: {} },
      { status: 200, compressionFailed: 1 },
    ].map((value) => ({ value })),
  )("refuses the response $value", ({ value }) => {
    expect(isWorkerResult(value)).toBe(false);
  });

  it("accepts a valid job", () => {
    expect(isWorkerJob(workerJob())).toBe(true);
  });

  it.each(
    [
      null,
      { batch: null },
      { batch: {}, headers: null },
      { batch: { ...workerJob().batch, id: 1 } },
      { batch: { ...workerJob().batch, id: "" } },
      { batch: { ...workerJob().batch, attempts: "1" } },
      { batch: { ...workerJob().batch, attempts: 0.5 } },
      { batch: { ...workerJob().batch, attempts: -1 } },
      { batch: { ...workerJob().batch, records: null } },
      { batch: { ...workerJob().batch, records: [] } },
      { batch: { ...workerJob().batch, records: [null] } },
      { endpoint: 1 },
      { endpoint: "file:///tmp/private" },
      { kind: "other" },
      { serializer: "other" },
      { compression: "other" },
      { credentials: "other" },
      { priority: "other" },
      { timeoutMs: "1" },
      { timeoutMs: Infinity },
      { timeoutMs: 0 },
      { deadlineMs: "1" },
      { deadlineMs: Infinity },
      { deadlineMs: 0 },
      { headers: { bad: 1 } },
    ].map((over) => ({ over })),
  )("refuses the job override $over", ({ over }) => {
    expect(isWorkerJob(over === null ? null : { ...workerJob(), ...over })).toBe(false);
  });
});
