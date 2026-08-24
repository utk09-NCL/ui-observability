// src/utils/platform.ts
import {
  ANDROID_WEBVIEW_UA_PATTERN,
  IOS_DEVICE_UA_PATTERN,
  MACINTOSH_UA_PATTERN,
  MOBILE_UA_PATTERN,
  OPENFIN_UA_PATTERN,
  SAFARI_UA_TOKEN,
  WEBKIT_UA_TOKEN,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";

/**
 * Which kind of host this code is running in.
 *
 * Every record carries one of these, and dashboards split on it, so a wrong
 * answer here is wrong data everywhere rather than a broken feature.
 */
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

/**
 * What detection found out about this realm. Fixed for the realm's lifetime, which is why it is
 * cached.
 */
export interface PlatformMetadata {
  /** The host kind, decided once at first detection. */
  platform: PlatformType;
  /** OpenFin application uuid, where there is one. */
  openfinUuid?: string;
  /** OpenFin window or view name, where there is one. Unique within the application. */
  openfinName?: string;
  /** Raw user agent, or an empty string in a host that has no navigator. */
  userAgent: string;
  /** Whether this realm is a worker of any kind, and therefore has no DOM. */
  isWorker: boolean;
  /** Whether this document is the top-level one rather than a frame. */
  isTopLevelDocument: boolean;
}

/**
 * The global object as something indexable, since half of what detection looks for is not in any
 * type definition.
 */
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

/**
 * Work out what this realm is, once, and remember the answer.
 *
 * Order matters in the chain below. Workers are tested first because a worker
 * inside an OpenFin application is still a worker, and the OpenFin check is
 * tested before the webview and Node ones for the same reason.
 */
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
    platform = OPENFIN_UA_PATTERN.test(ua) ? "openfin" : "openfin_web";
    diagnostics.guard("openfin.unavailable", "reading fin.me.identity", () => {
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
  if (ANDROID_WEBVIEW_UA_PATTERN.test(ua)) {
    return true;
  }
  const ios =
    IOS_DEVICE_UA_PATTERN.test(ua) || (MACINTOSH_UA_PATTERN.test(ua) && MOBILE_UA_PATTERN.test(ua));
  return ios && ua.includes(WEBKIT_UA_TOKEN) && !ua.includes(SAFARI_UA_TOKEN);
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

/** Test seam. The cache is what makes a platform detected in one test file leak into the next. */
export function resetPlatformCache(): void {
  cached = null;
}
