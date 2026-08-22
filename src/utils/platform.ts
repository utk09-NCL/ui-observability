// src/utils/platform.ts
import type { Diagnostics } from "../core/diagnostics";

export type PlatformType =
  | "openfin"
  | "openfin_web"
  | "browser"
  | "mobile_webview"
  | "ionic"
  | "web_worker"
  | "shared_worker"
  | "service_worker"
  | "node";

export interface PlatformMetadata {
  platform: PlatformType;
  openfinUuid?: string;
  openfinName?: string;
  userAgent: string;
  isWorker: boolean;
  isTopLevelDocument: boolean;
}

type Global = typeof globalThis & Record<string, unknown>;

/**
 * Cached, because it cannot change for the lifetime of a realm.
 *
 * The current URL is deliberately NOT cached with it. That changes on every
 * route in a single page application, and caching it makes every record report
 * the landing page forever.
 */
let cached: PlatformMetadata | null = null;

/** Only ever used as the right-hand side of `instanceof`. */
type ScopeConstructor = abstract new (...args: never[]) => object;

/**
 * Whether the global object is an instance of a named scope constructor.
 *
 * This is the only reliable way to tell a window from a dedicated worker from a
 * service worker: the constructor of the global object is what differs. The
 * name is looked up dynamically because none of these types exist in a document,
 * and importing the worker lib alongside the DOM lib is not possible.
 */
function isGlobalScope(g: Global, name: string): boolean {
  const scope = g[name];
  if (scope === undefined) {
    return false;
  }
  return g instanceof (scope as ScopeConstructor);
}

/** Structural, because the OpenFin types are not a dependency of this package. */
interface FinLike {
  me?: { identity?: { uuid?: string; name?: string } };
}

export function detectPlatform(diagnostics: Diagnostics): PlatformMetadata {
  if (cached) {
    return cached;
  }
  const g = globalThis as Global;

  const ua = (g.navigator as Navigator | undefined)?.userAgent ?? "";
  let platform: PlatformType = "browser";
  let openfinUuid: string | undefined;
  let openfinName: string | undefined;
  let isWorker = false;

  // Read once, before the branch, so the identity getter is the only thing the
  // guard below has to protect against.
  const finMe = (g.fin as FinLike | undefined)?.me;

  if (isGlobalScope(g, "ServiceWorkerGlobalScope")) {
    platform = "service_worker";
    isWorker = true;
  } else if (isGlobalScope(g, "SharedWorkerGlobalScope")) {
    platform = "shared_worker";
    isWorker = true;
  } else if (isGlobalScope(g, "WorkerGlobalScope")) {
    platform = "web_worker";
    isWorker = true;
  } else if (finMe !== undefined) {
    // Both the desktop runtime and the Core Web adapter expose `fin`. Only the
    // desktop runtime additionally stamps its user agent.
    platform = /OpenFin/i.test(ua) ? "openfin" : "openfin_web";
    diagnostics.guard("capture.install_failed", "reading fin.me.identity", () => {
      const identity = finMe.identity;
      openfinUuid = identity?.uuid;
      openfinName = identity?.name;
    });
  } else if (g.Capacitor !== undefined || g.Ionic !== undefined) {
    platform = "ionic";
  } else if (g.cordova !== undefined || isWebView(ua)) {
    platform = "mobile_webview";
  } else if (typeof document === "undefined" && typeof process !== "undefined") {
    // The absence of a document is what makes this Node, not the presence of
    // `process`. Bundlers routinely inject a `process` shim into browser
    // bundles so that `process.env.NODE_ENV` resolves, and testing `process`
    // alone therefore reports real browsers as Node. Every dashboard split by
    // platform is then wrong, and nothing about it looks broken.
    platform = "node";
  }

  cached = {
    platform,
    openfinUuid,
    openfinName,
    userAgent: ua,
    isWorker,
    isTopLevelDocument: isTopLevel(),
  };
  return cached;
}

/**
 * An in-app webview, not a mobile browser.
 *
 * Android webviews carry the `wv` token, so that half is easy. iOS has no token
 * of its own and the test has to run the other way round: every real iOS browser
 * sends `Safari/`, and a webview embedded in an application does not. Matching
 * on `Mobile.*Safari` instead, which is the obvious version of this check,
 * classifies every iPhone running ordinary Safari as a webview, and then every
 * dashboard split by platform is wrong for all iOS traffic.
 */
function isWebView(ua: string): boolean {
  if (/\bwv\b/.test(ua)) {
    return true;
  }
  const ios =
    /\b(iPhone|iPad|iPod)\b/.test(ua) || (/\bMacintosh\b/.test(ua) && /\bMobile\b/.test(ua));
  return ios && ua.includes('AppleWebKit') && !ua.includes('Safari/');
}

/** Cross-origin access to window.top throws, and that itself proves we are framed. */
export function isTopLevel(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}

/** Read fresh every time. Never cache: it changes on every route. */
export function currentUrl(): string {
  try {
    return typeof location !== "undefined" ? location.href : "";
  } catch {
    return "";
  }
}

export function resetPlatformCache(): void {
  cached = null;
}
