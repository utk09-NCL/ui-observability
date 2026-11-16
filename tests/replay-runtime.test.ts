// tests/replay-runtime.test.ts
//
// Tests for how session replay is wired up through the public API. A fake recorder supplies
// the events, and a memory transport collects the log records.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservabilityRuntime } from "../src/core/runtime";
import {
  configure,
  createMemoryTransport,
  flush,
  getLogger,
  newSession,
  rotateSecurityContext,
  shutdown,
  startReplay,
  stopReplay,
} from "../src/index";
import type { ObservabilityConfig, ReplayPolicy, Transport } from "../src/models/config";
import type { ReplayRecord, ReplaySegment } from "../src/models/replay";

/** Settings for a runtime with no network and no other captures. */
const base = {
  endpoint: null,
  serviceName: "svc",
  storage: "memory",
  identity: "memory",
  bus: { mode: "off" },
  capture: { errors: false, rejections: false },
  diagnostics: { throttleMs: 0 },
} as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdown();
});

/**
 * Starts a runtime with a fake recorder.
 * @param replay Replay settings for the test.
 * @param over Other settings for the test.
 * @returns The transport, the segments and the fake recorder.
 */
async function start(replay: Partial<ReplayPolicy> = {}, over: ObservabilityConfig = {}) {
  const memory = createMemoryTransport();
  const segments: ReplaySegment[] = [];
  const emits: ((event: unknown, isCheckout?: boolean) => void)[] = [];
  const stop = vi.fn();
  const record = vi.fn((options: Record<string, unknown>) => {
    emits.push(options.emit as (typeof emits)[number]);
    return stop;
  }) as unknown as ReplayRecord & ReturnType<typeof vi.fn>;
  const loader = vi.fn(() => Promise.resolve({ record }));

  configure({
    ...base,
    transport: memory.transport,
    replay: {
      enabled: true,
      loader,
      afterErrorMs: 0,
      onSegment: (segment) => {
        segments.push(segment);
      },
      ...replay,
    },
    ...over,
  });
  await settle();

  return { memory, segments, emits, stop, record, loader };
}

/** Waits for every chunk load and every task it kicks off. */
async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Returns the names of the installed capture modules. */
const installed = (): string[] =>
  ObservabilityRuntime.current()!["captures"].map((capture) => capture.name);

describe("session replay in the runtime", () => {
  it("loads no recorder by default", async () => {
    const { loader } = await start({ enabled: false });

    expect(loader).not.toHaveBeenCalled();
    expect(installed()).toEqual([]);
  });

  it("starts the recorder with replay.enabled", async () => {
    const { record } = await start();

    expect(installed()).toEqual(["replay"]);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ERROR", (): void => getLogger("app").error("failed", new Error("x"))],
    ["FATAL", (): void => getLogger("app").fatal("down", new Error("x"))],
  ])("sends the buffer as segments for a record of the level %s", async (_level, log) => {
    const { segments, emits } = await start();

    emits[0]({ type: 4 });
    emits[0]({ type: 2 });
    log();
    await settle();

    expect(segments.map((segment) => JSON.parse(segment.payload) as unknown)).toEqual([
      [{ type: 4 }, { type: 2 }],
    ]);
    expect(segments[0]["service.name"]).toBe("svc");
  });

  it("sends nothing for a record below the level ERROR", async () => {
    const { segments, emits } = await start();

    emits[0]({ type: 4 });
    getLogger("app").warn("slow");
    await settle();

    expect(segments).toEqual([]);
  });

  it("puts the replay id, the session id and the tab id of the error record on the segment", async () => {
    const { memory, segments, emits } = await start();

    emits[0]({ type: 4 });
    getLogger("app").info("before");
    getLogger("app").error("failed", new Error("x"));
    await settle();

    const records = memory.records();
    const failed = records.find((record) => record.body === "failed");
    // Every record carries the replay id while the recorder runs, so you can find the replay.
    expect(records.map((record) => record.attributes["replay.id"])).toEqual([
      segments[0]["replay.id"],
      segments[0]["replay.id"],
    ]);
    expect(segments[0]["session.id"]).toBe(failed?.resource["session.id"]);
    expect(segments[0]["tab.id"]).toBe(failed?.resource["tab.id"]);
  });

  it("waits for startReplay() with requireConsent, and stops at stopReplay()", async () => {
    const { memory, record, stop } = await start({ requireConsent: true });
    expect(record).not.toHaveBeenCalled();

    startReplay();
    await settle();
    expect(record).toHaveBeenCalledTimes(1);

    stopReplay();
    getLogger("app").info("after the stop");
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(memory.records().at(-1)?.attributes).not.toHaveProperty("replay.id");
  });

  it("keeps a consent that the app gave before the recorder chunk was installed", async () => {
    startReplay();
    const { record } = await start({ requireConsent: true });

    expect(record).toHaveBeenCalledTimes(1);
  });

  it("does nothing at startReplay() and stopReplay() while the replay is off", async () => {
    const { loader } = await start({ enabled: false });

    expect(() => {
      startReplay();
      stopReplay();
    }).not.toThrow();
    await settle();

    expect(loader).not.toHaveBeenCalled();
  });

  it("stops the recorder when configure() turns the replay off", async () => {
    const { stop } = await start();

    configure({ replay: { enabled: false } });
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(installed()).toEqual([]);
  });

  it("starts the recorder again when configure() changes a replay setting", async () => {
    const { record, stop } = await start();

    configure({ replay: { bufferMs: 10_000 } });
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);
    expect(vi.mocked(record).mock.calls[1][0]).toMatchObject({ checkoutEveryNms: 5000 });
  });

  it("keeps the recorder and its buffer when configure() changes another capture", async () => {
    const { record, stop, segments, emits } = await start();
    const replay = ObservabilityRuntime.current()!["captures"][0];

    emits[0]({ type: 4 });
    emits[0]({ type: 2 });
    configure({ capture: { errors: true } });
    await settle();

    // The error capture is new, and the replay capture is still the same running instance.
    expect(installed()).toEqual(["replay", "errors"]);
    expect(ObservabilityRuntime.current()!["captures"][0]).toBe(replay);
    expect(stop).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);

    // The events from before the reinstall are still the "before" of the next error.
    getLogger("app").error("failed", new Error("x"));
    await settle();

    expect(segments.map((segment) => JSON.parse(segment.payload) as unknown)).toEqual([
      [{ type: 4 }, { type: 2 }],
    ]);
  });

  it("keeps the recorder when configure() changes a replay value that is read on use", async () => {
    const { record, stop, segments, emits } = await start();

    configure({
      replay: {
        batchSize: 1,
        batchBytes: 20_000,
        flushIntervalMs: 500,
        maxBufferBytes: 200_000,
        maxQueueBytes: 200_000,
        maxAttempts: 1,
        afterErrorMs: 100,
        uploadsPerWindow: 1,
      },
    });
    await settle();

    expect(stop).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);

    // The new batch size applies to the running recorder: one event per segment.
    emits[0]({ type: 4 });
    emits[0]({ type: 2 });
    getLogger("app").error("failed", new Error("x"));
    await settle();

    expect(segments.map((segment) => JSON.parse(segment.payload) as unknown)).toEqual([
      [{ type: 4 }],
      [{ type: 2 }],
    ]);
  });

  it.each<[string, ObservabilityConfig]>([
    ["replay.maskText", { replay: { maskText: false } }],
    ["replay.maskInputs", { replay: { maskInputs: false } }],
    ["replay.maskSelectors", { replay: { maskSelectors: [".account"] } }],
    ["replay.blockSelectors", { replay: { blockSelectors: ["#blotter"] } }],
    ["replay.recordCanvas", { replay: { recordCanvas: true } }],
    ["replay.plugins", { replay: { plugins: [() => ({ name: "p" })] } }],
    ["replay.recordOptions", { replay: { recordOptions: { ignoreSelector: ".ssn" } } }],
    [
      "replay.loader",
      { replay: { loader: () => Promise.resolve({ record: () => () => undefined }) } },
    ],
    ["capture.fullUrls", { capture: { fullUrls: true } }],
    // The recorder's network plugin reads this list to skip the library's own requests.
    ["capture.ignoreUrls", { capture: { ignoreUrls: [/api\.example/] } }],
  ])("starts a new recording when configure() changes %s", async (_key, change) => {
    const { stop } = await start();

    configure(change);
    await settle();

    // The buffer was recorded under the old privacy settings, so it must not survive.
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("starts the recorder with the new plugin when a plugin of the same count replaces one", async () => {
    const first = vi.fn(() => ({ name: "bodies" }));
    const second = vi.fn(() => ({ name: "no-bodies" }));
    const { record, stop } = await start({ plugins: [first] });

    configure({ replay: { plugins: [second] } });
    await settle();

    // The list has the same length, but the old plugin must not keep recording.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(vi.mocked(record).mock.calls[1][0]).toMatchObject({ plugins: [{ name: "no-bodies" }] });
  });

  it("drops the buffer when configure() gives another onSegment function", async () => {
    const { stop, segments, emits } = await start();
    const other: ReplaySegment[] = [];

    emits[0]({ type: 4 });
    configure({
      replay: {
        onSegment: (segment) => {
          other.push(segment);
        },
      },
    });
    await settle();
    getLogger("app").error("failed", new Error("x"));
    await settle();

    // Events recorded for the first function don't go to the second one.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(segments).toEqual([]);
    expect(other).toEqual([]);
  });

  it("keeps the recorder when configure() only gives new replay.headers", async () => {
    const { record, stop } = await start();

    configure({ replay: { headers: { Authorization: "Bearer refreshed" } } });
    await settle();

    // A refreshed token must not cost the buffer.
    expect(stop).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("does not keep a recorder that restarted while other settings were in effect", async () => {
    const { record } = await start();

    // The mask goes off, and before that install has loaded, a new session restarts the
    // recorder with the mask off. Then the mask goes on again, back to the first key.
    configure({ replay: { maskText: false } });
    newSession();
    configure({ replay: { maskText: true } });
    await settle();

    // The recorder that runs now was started with the mask on.
    const starts = vi.mocked(record).mock.calls;
    expect(starts.at(-1)![0]).toMatchObject({ maskTextSelector: "*" });
    expect(ObservabilityRuntime.current()!.config.replay.maskText).toBe(true);
  });

  it("uninstalls the recorder when replay goes off while another install is loading", async () => {
    const { record, stop } = await start();

    configure({ replay: { maskText: false } });
    configure({ replay: { enabled: false } });
    await settle();

    expect(installed()).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("stops the recorder when configure() turns on replay.requireConsent", async () => {
    const { record, stop } = await start();

    configure({ replay: { requireConsent: true } });
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("starts the recorder when a later configure() adds the missing endpoint", async () => {
    const { record } = await start({ onSegment: null });

    expect(record).not.toHaveBeenCalled();

    configure({ replay: { onSegment: () => undefined } });
    await settle();

    expect(record).toHaveBeenCalledTimes(1);
  });

  it("drops the buffer when configure() changes replay.endpoint", async () => {
    const { record, stop, segments, emits } = await start();

    emits[0]({ type: 4 });
    emits[0]({ type: 2 });
    configure({ replay: { endpoint: "https://replay-b.example/v1/replay" } });
    await settle();

    // What was recorded for the old destination must not go to the new one.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);

    getLogger("app").error("failed", new Error("x"));
    await settle();

    expect(segments).toEqual([]);
  });

  it("starts the recorder when a later configure() adds the missing loader", async () => {
    const { record, loader } = await start({ loader: null });

    expect(record).not.toHaveBeenCalled();

    configure({ replay: { loader } });
    await settle();

    expect(record).toHaveBeenCalledTimes(1);
  });

  it("starts a new recorder when an install is replaced during its load", async () => {
    const { record, stop } = await start();

    // The first call asks for a new recording. The second call arrives before that install
    // has loaded, and it must not keep the old recorder with the old mask.
    configure({ replay: { maskText: false } });
    configure({ capture: { errors: true } });
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);
    expect(vi.mocked(record).mock.calls[1][0]).toMatchObject({ maskTextSelector: undefined });
  });

  it("keeps the recorder when configure() changes another setting", async () => {
    const { record, stop } = await start();

    configure({ minLevel: "INFO" });
    await settle();

    expect(stop).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a cycle",
      (): Record<string, unknown> => {
        const options: Record<string, unknown> = {};
        options.self = options;
        return options;
      },
    ],
    ["a BigInt", (): Record<string, unknown> => ({ limit: 10n })],
    [
      "a getter that throws",
      (): Record<string, unknown> => ({
        get sampling(): never {
          throw new Error("hostile options");
        },
      }),
    ],
  ])(
    "accepts recordOptions with %s while the replay is off, with no throw",
    async (_label, make) => {
      await start({ enabled: false }, { capture: { errors: true, rejections: false } });

      expect(() => {
        configure({ replay: { recordOptions: make() } });
        configure({ minLevel: "WARN" });
      }).not.toThrow();
      await settle();

      // The other captures still have to install.
      expect(installed()).toEqual(["errors"]);
    },
  );

  it("installs each capture when the first configure() has recordOptions with no JSON form", async () => {
    const { record } = await start(
      { recordOptions: { limit: 10n } },
      { capture: { errors: true, rejections: false } },
    );

    expect(installed()).toEqual(["errors", "replay"]);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["newSession()", (): void => newSession()],
    [
      "rotateSecurityContext()",
      (transport: Transport): Promise<void> =>
        rotateSecurityContext({ id: "user-b", delivery: { transport } }),
    ],
  ])(
    "drops the buffer of the old user at %s and starts a new recording",
    async (_label, change) => {
      const { memory, segments, emits, record, stop } = await start();
      emits[0]({ type: 4 });
      emits[0]({ type: 2, data: "dom of user A" });
      getLogger("app").info("user a");
      await settle();
      const before = memory.records().at(-1)?.attributes["replay.id"];
      const next = createMemoryTransport();

      await change(next.transport);
      await settle();

      // User A's recorder stopped, and a new recorder with a new id runs for user B.
      expect(stop).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(2);
      emits[1]({ type: 4 });
      emits[1]({ type: 2, data: "dom of user B" });
      getLogger("app").error("failed", new Error("x"));
      await settle();

      const payloads = segments.map((segment) => segment.payload).join("");
      expect(payloads).not.toContain("user A");
      expect(payloads).toContain("user B");
      const failed = [...memory.records(), ...next.records()].find((one) => one.body === "failed");
      expect(failed?.attributes["replay.id"]).toBe(segments[0]["replay.id"]);
      expect(failed?.attributes["replay.id"]).not.toBe(before);
    },
  );

  it("keeps the recorder off after stopReplay() when configure() installs the captures again", async () => {
    const { record, stop } = await start();

    stopReplay();
    configure({ capture: { lifecycle: true } });
    await settle();

    // The user stopped the replay, so a reinstall must not start it again.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);

    startReplay();
    await settle();
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("does not throw at startReplay() when a plugin of the app has the name replay", async () => {
    const plugin = { name: "replay", install: vi.fn(), uninstall: vi.fn() };
    await start(
      { enabled: false },
      { capture: { errors: false, rejections: false, plugins: [plugin] } },
    );

    expect(() => {
      startReplay();
      stopReplay();
    }).not.toThrow();
  });

  it("starts no new install for a replay change while the replay is off", async () => {
    await start({ enabled: false }, { capture: { errors: true, rejections: false } });
    const [errors] = ObservabilityRuntime.current()!["captures"];

    configure({ replay: { bufferMs: 10_000, maskSelectors: [".account"] } });
    await settle();

    // Still the same error capture instance, so there was no reinstall. A reinstall re-patches
    // every host function.
    expect(ObservabilityRuntime.current()!["captures"][0]).toBe(errors);
  });

  it("stops the recorder at shutdown()", async () => {
    const { stop } = await start();

    await shutdown();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
