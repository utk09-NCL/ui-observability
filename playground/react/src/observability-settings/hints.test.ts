import { describe, expect, it } from "vitest";
import {
  configure,
  flush,
  getLogger,
  shutdown,
  type DiagnosticEvent,
} from "@utk09/ui-observability";
import { memory } from "../../test/observability";
import { configFor, formatValue, HINTS, type Hint, withFasterValues } from "./hints";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

const runtimeHints = HINTS.filter((hint) => hint.applies === "runtime");
const restartHints = HINTS.filter((hint) => hint.applies === "restart");

/** Settings with one setting set to one value. */
function withValue(hint: Hint, value: unknown): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  Reflect.set(settings, hint.key, value);

  return settings;
}

/** The config section that a hint writes, for example "limits" for limits.maxDepth. */
function sectionOf(hint: Hint): string {
  return hint.path.split(",")[0].trim().split(".")[0];
}

function collectInvalid(): { invalid: () => DiagnosticEvent[] } {
  const events: DiagnosticEvent[] = [];
  // The library gives a handler one report of a code in each second. With 0 it gives each one,
  // so a second wrong key in the same call can't hide behind the first.
  configure({ onDiagnostic: (event) => events.push(event), diagnostics: { throttleMs: 0 } });

  return { invalid: () => events.filter((event) => event.code === "config.invalid") };
}

describe("hint catalog", () => {
  it("has one hint for each setting", () => {
    expect(HINTS.map((hint) => hint.key).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it("offers the default value and the faster value of each hint", () => {
    for (const hint of HINTS) {
      const options: readonly unknown[] = hint.options;

      expect(options).toContain(DEFAULT_SETTINGS[hint.key]);
      if (hint.faster !== null) {
        expect(options).toContain(hint.faster);
      }
    }
  });

  it("marks only the settings that the cost meter shows as measure here", () => {
    const measurable = HINTS.filter((hint) => hint.evidence === "measure here").map(
      (hint) => hint.key,
    );

    expect(measurable.sort()).toEqual(
      ["consoleOutput", "maxArrayLength", "maxDepth", "maxNodes", "minLevel", "payloadMode"].sort(),
    );
    // The replay row cites the run of docs/performance.md, so it is the one measured row.
    expect(HINTS.filter((hint) => hint.evidence === "measured").map((hint) => hint.key)).toEqual([
      "replayEnabled",
    ]);
  });

  it("calls no compression value faster", () => {
    const compression = HINTS.find((hint) => hint.key === "compression");

    expect(compression?.faster).toBeNull();
    expect(withFasterValues(DEFAULT_SETTINGS).compression).toBe(DEFAULT_SETTINGS.compression);
  });

  it("writes the config key that its path names", () => {
    for (const hint of HINTS) {
      // A value other than the default, because a default can add nothing, such as no worker.
      const other = hint.options.find((option) => option !== DEFAULT_SETTINGS[hint.key]);
      const config = hint.toConfig(withValue(hint, other));
      const parts = hint.path.split(",")[0].trim().split(".");
      const child = parts.at(1);
      const section: unknown = Reflect.get(config, parts[0]);

      expect(section, hint.path).not.toBeUndefined();
      if (child !== undefined && typeof section === "object" && section !== null) {
        expect(section, hint.path).toHaveProperty(child);
      }
    }
  });

  it("merges the settings that write into one section", () => {
    const config = configFor({ ...DEFAULT_SETTINGS, fetch: false, console: false }, "runtime");

    expect(config.capture).toMatchObject({
      fetch: false,
      httpMetrics: false,
      propagateTraceHeaderTo: [],
      console: false,
      webSocket: true,
    });
  });

  it("gives the click options and the profiler options one section each", () => {
    const config = configFor(
      { ...DEFAULT_SETTINGS, rageClicks: false, profiler: false, framePhases: true },
      "runtime",
    );

    expect(config.capture?.interactions).toEqual({
      text: false,
      rageClicks: false,
      deadClicks: true,
    });
    // The frame options need the profiler, so they follow it.
    expect(config.profiler).toEqual({ enabled: false, framePhases: false, framePacing: false });
  });

  it("turns click capture off with its sub-options", () => {
    const config = configFor({ ...DEFAULT_SETTINGS, interactions: false }, "runtime");

    expect(config.capture?.interactions).toBe(false);
  });

  it("gives the two replay rows one section, and keeps the recorder off the canvas by default", () => {
    expect(configFor(DEFAULT_SETTINGS, "runtime").replay).toEqual({
      enabled: true,
      recordCanvas: false,
    });
    expect(configFor({ ...DEFAULT_SETTINGS, recordCanvas: true }, "runtime").replay).toMatchObject({
      recordCanvas: true,
    });
  });

  it("gives the web vitals loader as one function, and turns the capture off with false", () => {
    const on = configFor(DEFAULT_SETTINGS, "runtime").capture?.webVitals;
    const again = configFor(DEFAULT_SETTINGS, "runtime").capture?.webVitals;
    const off = configFor({ ...DEFAULT_SETTINGS, webVitals: false }, "runtime").capture?.webVitals;

    // configure() counts a function as the same setting only when it is the same reference.
    expect(on).toHaveProperty("loader");
    expect(typeof (on as { loader: unknown }).loader).toBe("function");
    expect(on).toEqual(again);
    expect(off).toBe(false);
  });

  it("builds the span endpoint on the origin of the page", () => {
    const config = configFor(DEFAULT_SETTINGS, "restart");

    expect(config.tracesEndpoint).toBe(`${location.origin}/telemetry/v1/traces`);
  });

  it("splits the config by the way that it applies", () => {
    expect(configFor(DEFAULT_SETTINGS, "runtime")).not.toHaveProperty("limits");
    expect(configFor(DEFAULT_SETTINGS, "restart")).toHaveProperty("limits");
    expect(configFor(DEFAULT_SETTINGS, "restart")).not.toHaveProperty("capture");
  });

  it("prints values for the panel", () => {
    expect(formatValue(true)).toBe("on");
    expect(formatValue(false)).toBe("off");
    expect(formatValue(2000, "ms")).toBe("2000 ms");
    expect(formatValue("INFO")).toBe("INFO");
  });
});

describe("hints that apply at runtime", () => {
  it.each(runtimeHints.map((hint) => [hint.key, hint] as const))(
    "configure() takes each value of %s without config.invalid",
    async (_key, hint) => {
      // Only this hint's own config goes in, so a failure names the hint that caused it.
      await flush();
      const { invalid } = collectInvalid();

      for (const option of hint.options) {
        configure(hint.toConfig(withValue(hint, option)));
      }

      expect(invalid().map((event) => event.message)).toEqual([]);
    },
  );
});

describe("hints that need a restart", () => {
  it.each(restartHints.map((hint) => [hint.key, hint] as const))(
    "configure() refuses a change of %s on a running library and names its section",
    async (_key, hint) => {
      // The delivery stack loads at the first record. After that, batching is fixed too.
      getLogger("hints.spec").info("load the sender");
      await flush();
      const { invalid } = collectInvalid();

      for (const option of hint.options) {
        configure(hint.toConfig(withValue(hint, option)));
      }

      const section = sectionOf(hint);

      expect(
        invalid().some((event) => event.message.includes(section)),
        `no config.invalid names ${section}`,
      ).toBe(true);
    },
  );

  it.each(restartHints.map((hint) => [hint.key, hint] as const))(
    "a new runtime takes each value of %s",
    async (_key, hint) => {
      // The one report that this setup causes, as an exact text. A wrong key name or a wrong
      // shape gives a different text and fails the spec.
      const allowed = ["transportWorker has no effect with transport. The value stays."];
      const events: DiagnosticEvent[] = [];

      for (const option of hint.options) {
        await shutdown();
        configure({
          serviceName: "react-workspace",
          transport: memory.transport,
          storage: { backend: "none" },
          bus: { mode: "off" },
          identity: "memory",
          onDiagnostic: (event) => events.push(event),
          diagnostics: { throttleMs: 0 },
          ...hint.toConfig(withValue(hint, option)),
        });
      }

      const unexpected = events
        .filter((event) => event.code === "config.invalid")
        .map((event) => event.message)
        .filter((message) => !allowed.includes(message));

      expect(unexpected).toEqual([]);
    },
  );
});
