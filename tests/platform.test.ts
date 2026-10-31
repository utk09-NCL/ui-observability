// tests/platform.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import {
  currentUrl,
  detectPlatform,
  isTopLevel,
  resetPlatformCache,
  recordedUrl,
  stripUrlQuery,
} from "../src/utils/platform";

const diag = (): Diagnostics => new Diagnostics(vi.fn(), 0);

// The shared setup resets the cache after each test. A stub inside one test must not stay after it.
// The cache must be cold when the stub goes.
afterEach(() => {
  vi.unstubAllGlobals();
  resetPlatformCache();
});

/**
 * `globalThis instanceof X` depends only on X. An object with Symbol.hasInstance can act as a
 * worker scope constructor. Only this seam lets a document reach all three worker branches. It
 * needs no class.
 */
const alwaysAnInstance = { [Symbol.hasInstance]: () => true };

describe("detectPlatform", () => {
  it("is a browser by default, and caches the answer", () => {
    const first = detectPlatform(diag());

    expect(first.platform).toBe("browser");
    expect(first.isWorker).toBe(false);
    // The same object, not merely an equal one.
    expect(detectPlatform(diag())).toBe(first);
  });

  it.each([
    ["ServiceWorkerGlobalScope", "service_worker"],
    ["SharedWorkerGlobalScope", "shared_worker"],
    ["WorkerGlobalScope", "web_worker"],
  ])("detects %s", (globalName, expected) => {
    // The order is important. The detector checks the service worker first. A stub of only the
    // scope under test reaches the later branches.
    vi.stubGlobal(globalName, alwaysAnInstance);

    const meta = detectPlatform(diag());

    expect(meta.platform).toBe(expected);
    expect(meta.isWorker).toBe(true);
  });

  it("splits OpenFin desktop from Core Web on the user agent", () => {
    vi.stubGlobal("fin", { me: { identity: { uuid: "app-1", name: "view-1" } } });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 OpenFin/34.114.80.5" });

    const desktop = detectPlatform(diag());

    expect(desktop.platform).toBe("openfin");
    expect(desktop.openfinUuid).toBe("app-1");
    expect(desktop.openfinName).toBe("view-1");

    resetPlatformCache();
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Chrome/120" });

    expect(detectPlatform(diag()).platform).toBe("openfin_web");
  });

  it("reports rather than throws when fin.me.identity cannot be read", () => {
    const handler = vi.fn();
    vi.stubGlobal("fin", {
      me: new Proxy(
        {},
        {
          get() {
            throw new Error("blocked by the runtime");
          },
        },
      ),
    });
    vi.stubGlobal("navigator", { userAgent: "OpenFin/34" });

    const meta = detectPlatform(new Diagnostics(handler, 0));

    expect(meta.platform).toBe("openfin");
    expect(meta.openfinUuid).toBeUndefined();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: "openfin.unavailable" }));
  });

  it("copes with an OpenFin context that exposes no identity", () => {
    vi.stubGlobal("fin", { me: {} });
    vi.stubGlobal("navigator", { userAgent: "OpenFin/34" });

    const meta = detectPlatform(diag());

    expect(meta.platform).toBe("openfin");
    expect(meta.openfinUuid).toBeUndefined();
    expect(meta.openfinName).toBeUndefined();
  });

  it("recognises a Capacitor shell, an Ionic shell and a Cordova shell", () => {
    vi.stubGlobal("Capacitor", {});
    expect(detectPlatform(diag()).platform).toBe("ionic");

    resetPlatformCache();
    vi.unstubAllGlobals();
    vi.stubGlobal("Ionic", {});
    expect(detectPlatform(diag()).platform).toBe("ionic");

    resetPlatformCache();
    vi.unstubAllGlobals();
    vi.stubGlobal("cordova", {});
    expect(detectPlatform(diag()).platform).toBe("mobile_webview");
  });

  it("calls an Android webview a webview and iOS Safari a browser", () => {
    // This half is easy to get wrong. The obvious check matches `Mobile.*Safari`. That check calls
    // each iPhone on ordinary Safari an in-app webview. Each dashboard that splits by platform is
    // then wrong for all iOS traffic.
    const androidWebview = "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36";
    const iosWebview =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
    const iosSafari = `${iosWebview} Version/17.0 Mobile/15E148 Safari/604.1`;
    // iPadOS reports itself as a Macintosh, and only the Mobile token gives it
    // away.
    const ipadWebview =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Mobile/15E148";
    const desktopSafari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";

    for (const [userAgent, expected] of [
      [androidWebview, "mobile_webview"],
      [iosWebview, "mobile_webview"],
      [ipadWebview, "mobile_webview"],
      [iosSafari, "browser"],
      [desktopSafari, "browser"],
    ] as const) {
      resetPlatformCache();
      vi.stubGlobal("navigator", { userAgent });

      expect(detectPlatform(diag()).platform, userAgent).toBe(expected);
    }
  });

  it("reports an empty user agent rather than failing when there is no navigator", () => {
    vi.stubGlobal("navigator", undefined);

    expect(detectPlatform(diag()).userAgent).toBe("");
  });

  it("is Node only when there is no document, not merely because process exists", () => {
    // This test run defines process. The default detection above still reports a browser. That is
    // the purpose of the test. Bundlers put a process shim into browser bundles. process alone
    // proves nothing.
    vi.stubGlobal("document", undefined);

    expect(detectPlatform(diag()).platform).toBe("node");
  });
});

describe("isTopLevel", () => {
  it("is true in a document that is its own top", () => {
    expect(isTopLevel(diag())).toBe(true);
  });

  it("is false when framed", () => {
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);

    expect(isTopLevel(diag())).toBe(false);
  });

  it("is false and counts the fault when reading window.top throws", () => {
    const diagnostics = diag();
    vi.spyOn(window, "top", "get").mockImplementation(() => {
      throw new DOMException("blocked a frame", "SecurityError");
    });

    expect(isTopLevel(diagnostics)).toBe(false);
    expect(diagnostics.snapshot()["platform.api_blocked"]).toBe(1);
  });

  it("is false where there is no window at all", () => {
    vi.stubGlobal("window", undefined);

    expect(isTopLevel(diag())).toBe(false);
  });
});

describe("currentUrl", () => {
  it("reads the location fresh", () => {
    expect(currentUrl(diag())).toBe(location.href);
  });

  it("is empty where there is no location", () => {
    vi.stubGlobal("location", undefined);

    expect(currentUrl(diag())).toBe("");
  });

  it("is empty and counts the fault when reading the location throws", () => {
    const diagnostics = diag();
    vi.stubGlobal("location", {
      get href(): string {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    expect(currentUrl(diagnostics)).toBe("");
    expect(diagnostics.snapshot()["platform.api_blocked"]).toBe(1);
  });
});

describe("recordedUrl", () => {
  it("removes the user info, and the query and fragment without fullUrls", () => {
    const url = "https://user:pass@app.test/a?token=1#b";

    expect(recordedUrl(url, false)).toBe("https://app.test/a");
    expect(recordedUrl(url, true)).toBe("https://app.test/a?token=1#b");
    expect(recordedUrl("/api/orders?x=1", false)).toBe("/api/orders");
    expect(recordedUrl("https://app.test/a@b", true)).toBe("https://app.test/a@b");
  });
});

describe("stripUrlQuery", () => {
  it("drops the query string, which is where tokens and user input travel", () => {
    expect(stripUrlQuery("https://app.test/checkout?token=secret&q=me")).toBe(
      "https://app.test/checkout",
    );
  });

  it("drops the fragment", () => {
    expect(stripUrlQuery("https://app.test/checkout#step2")).toBe("https://app.test/checkout");
  });

  it("cuts at whichever of query and fragment comes first", () => {
    expect(stripUrlQuery("https://app.test/a#b?c=1")).toBe("https://app.test/a");
    expect(stripUrlQuery("https://app.test/a?c=1#b")).toBe("https://app.test/a");
  });

  it("leaves a URL that carries neither alone", () => {
    expect(stripUrlQuery("https://app.test/checkout")).toBe("https://app.test/checkout");
  });

  it("handles a relative request target, which has no base to parse against", () => {
    expect(stripUrlQuery("/api/orders?token=secret")).toBe("/api/orders");
  });

  it("returns an empty string unchanged", () => {
    expect(stripUrlQuery("")).toBe("");
  });
});
