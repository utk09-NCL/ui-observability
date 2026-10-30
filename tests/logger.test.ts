import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObservabilityRuntime } from "../src/core/runtime";
import type { LogRecord } from "../src/models/log-record";
import {
  configure,
  fatal,
  getDiagnosticCounters,
  getLogger,
  logAction,
  OneLogger,
  shutdown,
} from "../src/index";

const base = {
  endpoint: "https://x/v1/logs",
  serviceName: "svc",
  minLevel: "TRACE" as const,
};

/**
 * The runtime pinned to this realm, which every test has configured first.
 * @returns The runtime.
 */
function runtime(): ObservabilityRuntime {
  const current = ObservabilityRuntime.current();
  if (!current) {
    throw new Error("no runtime configured");
  }
  return current;
}

/**
 * Configures the runtime and records each emitted record.
 * @param over Config values layered over the base.
 * @returns The emitted records.
 */
function capture(over: Parameters<typeof configure>[0] = {}): LogRecord[] {
  configure({ ...base, ...over });
  const records: LogRecord[] = [];
  vi.spyOn(runtime(), "emit").mockImplementation((record) => {
    if (record) {
      records.push(record);
    }
  });
  return records;
}

/**
 * A proxy whose traps throw, as a hostile payload or reason does.
 * @returns The proxy.
 */
function hostile(): object {
  const fail = (): never => {
    throw new Error("trap");
  };
  return new Proxy({}, { ownKeys: fail, getPrototypeOf: fail, get: fail });
}

beforeEach(() => {
  vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("", { status: 204 }))),
  );
});

afterEach(async () => {
  await shutdown().catch(() => undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("log.type", () => {
  it("is log for each level of an application logger", () => {
    const records = capture();
    const log = getLogger("trading");

    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e", new Error("x"));
    log.fatal("f", new Error("x"));

    expect(records.map((record) => record.attributes["log.type"])).toEqual([
      "log",
      "log",
      "log",
      "log",
      "log",
      "log",
    ]);
  });

  it("is system for the namespaces of the library and their children only", () => {
    const records = capture();

    new OneLogger(() => runtime(), "uiobs.capture").info("own");
    new OneLogger(() => runtime(), "uiobs.storage").child("idb").warn("own child");
    new OneLogger(() => runtime(), "uiobs.captured").info("app");

    expect(records.map((record) => record.attributes["log.type"])).toEqual([
      "system",
      "system",
      "log",
    ]);
  });
});

describe("minLevel", () => {
  it("keeps an action below minLevel", () => {
    const records = capture({ minLevel: "ERROR" });

    logAction("SUBMIT_ORDER");
    getLogger("trading").info("dropped");

    expect(records.map((record) => record.body)).toEqual(["SUBMIT_ORDER"]);
  });
});

describe("logMetric", () => {
  it("drops a value that is not finite and reports it", () => {
    const records = capture();
    const log = getLogger("trading");

    log.logMetric("latency", Number.NaN);
    log.logMetric("latency", Number.POSITIVE_INFINITY);

    expect(records).toEqual([]);
    expect(getDiagnosticCounters()["record.dropped_malformed"]).toBe(2);
  });

  it("keeps the metric fields over caller attributes of the same name", () => {
    const records = capture();

    getLogger("trading").logMetric("latency", 12, "ms", "gauge", {
      "metric.name": "spoof",
      route: "/orders",
    });

    expect(records[0].attributes).toMatchObject({ "metric.name": "latency", route: "/orders" });
  });

  it("names the attributes of the call, so the metrics format keeps the context off the point", () => {
    const records = capture();

    getLogger("trading").logMetric("latency", 12, "ms", "gauge", { route: "/orders" });
    getLogger("trading").logMetric("rows", 3);

    expect(records[0].attributes["metric.attribute_keys"]).toEqual(["route"]);
    expect(records[1].attributes["metric.attribute_keys"]).toEqual([]);
  });

  it("marks the record when the attributes cannot be read", () => {
    const records = capture();

    expect(() => {
      getLogger("trading").logMetric("latency", 12, "ms", "gauge", hostile() as never);
    }).not.toThrow();

    expect(records[0].attributes["uiobs.sanitize_failed"]).toBe(true);
    expect(records[0].attributes["metric.value"]).toBe(12);
  });
});

describe("error and fatal", () => {
  it("does not throw on a payload or an error slot that throws on each read", () => {
    const records = capture();
    const log = getLogger("trading");

    expect(() => {
      log.error("payload", new Error("x"), hostile() as never);
      log.error("slot", hostile());
    }).not.toThrow();

    expect(records[0].attributes["uiobs.sanitize_failed"]).toBe(true);
    expect(records[1].attributes["error.type"]).toBe("Error");
    expect(getDiagnosticCounters()["record.sanitize_failed"]).toBeGreaterThan(0);
  });

  it("copies the name and stack of an error from another realm", () => {
    const records = capture();
    const foreign = {
      name: "TypeError",
      message: "x is undefined",
      stack: "TypeError: x is undefined\n    at render (app.js:1:1)",
    };

    getLogger("trading").error("render failed", foreign, { view: "blotter" });

    expect(records[0].attributes).toMatchObject({
      "error.type": "TypeError",
      "error.message": "x is undefined",
      "error.stack_trace": foreign.stack,
      view: "blotter",
    });
  });

  it("keeps the own fields of an Error as error.data", () => {
    const records = capture();
    // An assigned name is an own field. It stays out of error.data.
    const failure = Object.assign(new Error("gateway"), {
      name: "GatewayError",
      code: "E42",
      status: 503,
    });

    getLogger("trading").error("send failed", failure);
    getLogger("trading").error("plain", new Error("no fields"));

    expect(records[0].attributes["error.data"]).toEqual({ code: "E42", status: 503 });
    expect(records[1].attributes["error.data"]).toBeUndefined();
  });

  it("keeps only the string, number and boolean own fields of an error as error.data", () => {
    const records = capture();
    const log = getLogger("trading");
    // An AxiosError has config, request and response as own fields. They hold the credentials.
    const axios = Object.assign(new Error("Request failed with status code 500"), {
      code: "ERR_BAD_RESPONSE",
      status: 500,
      isAxiosError: true,
      config: { headers: { Authorization: "Bearer secret" }, data: '{"password":"pw"}' },
      response: { data: { token: "t" } },
    });
    const reason = { code: 7, config: { auth: { password: "pw" } } };

    log.error("send failed", axios);
    log.error("object", reason, { view: "blotter" });

    expect(records[0].attributes["error.data"]).toEqual({
      code: "ERR_BAD_RESPONSE",
      status: 500,
      isAxiosError: true,
    });
    expect(records[1].attributes["error.data"]).toEqual({ code: 7 });
  });

  it("does not throw on a Proxy around an Error that throws on each read", () => {
    const records = capture();
    const trap = new Proxy(new Error("x"), {
      get: () => {
        throw new Error("trap");
      },
    });

    expect(() => {
      getLogger("trading").error("proxy", trap);
    }).not.toThrow();

    expect(records[0].body).toBe("proxy");
    expect(getDiagnosticCounters()["record.sanitize_failed"]).toBeGreaterThan(0);
  });

  it("keeps a reason that is not an Error as error.data", () => {
    const records = capture();
    const log = getLogger("trading");

    log.error("number", 42);
    log.error("object", { code: 7 }, { view: "blotter" });
    log.error("text", "timeout");
    log.error("bigint", 10n);

    expect(records[0].attributes["error.data"]).toBe(42);
    expect(records[1].attributes["error.data"]).toEqual({ code: 7 });
    expect(records[2].attributes["error.data"]).toBeUndefined();
    expect(records[2].attributes["error.message"]).toBe("timeout");
    expect(records[3].attributes["error.data"]).toBe("10n");
  });

  it("logs a fatal record from the top-level function", () => {
    const records = capture();

    fatal("process lost", new Error("worker died"), { worker: "pricing" });

    expect(records[0]).toMatchObject({
      severityText: "FATAL",
      body: "process lost",
      attributes: { "error.message": "worker died", worker: "pricing" },
    });
  });
});

describe("breadcrumbs", () => {
  it("keep the body of the record after redact", () => {
    const records = capture({
      redact: (record) => ({ ...record, body: record.body.replace(/\d+/g, "#") }),
    });
    const log = getLogger("trading");

    log.info("card 4111");
    log.error("failed", new Error("x"));

    const crumbs = records[1].attributes.breadcrumbs as { message: string }[];
    expect(crumbs.at(-1)?.message).toBe("card #");
  });
});
