// tests/platform.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { Diagnostics } from "../src/core/diagnostics";
import { currentUrl, detectPlatform, isTopLevel, resetPlatformCache } from "../src/utils/platform";

const diag = (): Diagnostics => new Diagnostics(vi.fn(), 0);

// The shared setup file resets the cache after every test, but a stub applied
// inside one of these must not outlive it either, and the cache has to be cold
// again the moment a stub is removed.
afterEach(() => {
  vi.unstubAllGlobals();
  resetPlatformCache();
});

/**
 * `globalThis instanceof X` is decided entirely by X, so an object carrying
 * Symbol.hasInstance is enough to impersonate a worker scope constructor. This
 * is the only seam that makes all three worker branches reachable from a
 * document, and it needs no class.
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
    // Order matters: the detector checks service worker first, so stubbing only
    // the one under test is what reaches the later branches.
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
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "capture.install_failed" }),
    );
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
    // The half that is easy to get backwards. Matching `Mobile.*Safari`, which
    // is the obvious version of this check, calls every iPhone on ordinary
    // Safari an in-app webview, and then every dashboard split by platform is
    // wrong for all iOS traffic.
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
    // process is defined in this test run, and the default detection above
    // still reports a browser. That is the whole point: bundlers inject a
    // process shim into browser bundles, so process alone proves nothing.
    vi.stubGlobal("document", undefined);

    expect(detectPlatform(diag()).platform).toBe("node");
  });
});

describe("isTopLevel", () => {
  it("is true in a document that is its own top", () => {
    expect(isTopLevel()).toBe(true);
  });

  it("is false when framed", () => {
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);

    expect(isTopLevel()).toBe(false);
  });

  it("is false when reading window.top throws, which itself proves we are framed", () => {
    vi.spyOn(window, "top", "get").mockImplementation(() => {
      throw new DOMException("blocked a frame", "SecurityError");
    });

    expect(isTopLevel()).toBe(false);
  });

  it("is false where there is no window at all", () => {
    vi.stubGlobal("window", undefined);

    expect(isTopLevel()).toBe(false);
  });
});

describe("currentUrl", () => {
  it("reads the location fresh", () => {
    expect(currentUrl()).toBe(location.href);
  });

  it("is empty where there is no location", () => {
    vi.stubGlobal("location", undefined);

    expect(currentUrl()).toBe("");
  });

  it("is empty when reading the location throws", () => {
    vi.stubGlobal("location", {
      get href(): string {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    expect(currentUrl()).toBe("");
  });
});
