// src/utils/platform.ts
//
// Detects host platform capabilities, OpenFin container metadata, and worker
// execution realms. The module caches the result. The result does not change during
// the life of a realm. A webview is also a browser. Test for a webview first.

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
import { getFin } from "./openfin";

/** Host runtime environment classification attached to resource attributes. */
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

/** Host environment and runtime container metadata resolved at startup. */
export interface PlatformMetadata {
  /** Detected platform runtime classification. */
  platform: PlatformType;
  /** OpenFin application UUID if running inside an OpenFin container. */
  openfinUuid?: string;
  /** OpenFin window or view identifier. */
  openfinName?: string;
  /** Raw navigator user agent string or empty string if unavailable. */
  userAgent: string;
  /** True if the code runs in a worker realm. */
  isWorker: boolean;
  /** True if this context is the top-level document rather than an iframe. */
  isTopLevelDocument: boolean;
}

/** Indexed globalThis type for probing runtime globals. */
type Global = typeof globalThis & Record<string, unknown>;

/** Cached platform metadata instance. */
let cached: PlatformMetadata | null = null;

/** Abstract constructor type for global scope prototype checks. */
type ScopeConstructor = abstract new (...args: never[]) => object;

/**
 * Tests if globalThis is an instance of a specified global scope constructor.
 * @param g Global scope object.
 * @param name Scope constructor name to check.
 * @returns True if globalThis inherits from the named scope constructor.
 */
function isGlobalScope(g: Global, name: string): boolean {
  const scope = g[name];
  if (scope === undefined) {
    return false;
  }
  return g instanceof (scope as ScopeConstructor);
}

/**
 * Detects and caches host platform metadata for the active realm.
 * @param diagnostics Diagnostics reporter.
 * @returns Detected PlatformMetadata.
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

  const finMe = getFin()?.me;

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
    platform = OPENFIN_UA_PATTERN.test(ua) ? "openfin" : "openfin_web";
    diagnostics.guard("openfin.unavailable", "The library could not read fin.me.identity.", () => {
      const identity = finMe.identity;
      openfinUuid = identity?.uuid;
      openfinName = identity?.name;
    });
  } else if (g.Capacitor !== undefined || g.Ionic !== undefined) {
    platform = "ionic";
  } else if (g.cordova !== undefined || isWebView(ua)) {
    platform = "mobile_webview";
  } else if (typeof document === "undefined" && typeof process !== "undefined") {
    platform = "node";
  }

  cached = {
    platform,
    openfinUuid,
    openfinName,
    userAgent: ua,
    isWorker,
    isTopLevelDocument: isTopLevel(diagnostics),
  };
  return cached;
}

/**
 * Tests if a user agent string represents an embedded mobile webview.
 * @param ua User agent string.
 * @returns True if user agent matches Android or iOS webview signatures.
 */
function isWebView(ua: string): boolean {
  if (ANDROID_WEBVIEW_UA_PATTERN.test(ua)) {
    return true;
  }
  const ios =
    IOS_DEVICE_UA_PATTERN.test(ua) || (MACINTOSH_UA_PATTERN.test(ua) && MOBILE_UA_PATTERN.test(ua));
  return ios && ua.includes(WEBKIT_UA_TOKEN) && !ua.includes(SAFARI_UA_TOKEN);
}

/**
 * Tests if the current window is the top-level browsing context.
 * @param diagnostics Diagnostics reporter. It counts a blocked read of window.top.
 * @returns True if top-level, false if framed or inaccessible due to cross-origin boundaries.
 */
export function isTopLevel(diagnostics: Diagnostics): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.self === window.top;
  } catch {
    // A cross-origin parent blocks the read. That proves a frame. Count it. Do not report it.
    diagnostics.count("platform.api_blocked");
    return false;
  }
}

/**
 * Retrieves the current document URL without caching.
 * @param diagnostics Diagnostics reporter. It counts a blocked read of location.href.
 * @returns Current location.href or empty string.
 */
export function currentUrl(diagnostics: Diagnostics): string {
  try {
    return typeof location !== "undefined" ? location.href : "";
  } catch {
    // A sandbox can block the read. Count the fault. A report on each record is noise.
    diagnostics.count("platform.api_blocked");
    return "";
  }
}

/** Matches the user info of an absolute URL, for example "user:pass@". */
const USER_INFO_PATTERN = /^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/i;

/**
 * Gives the form of a URL that the library records. It always removes the user info, which is a
 * credential. Without fullUrls, it also removes the query and the fragment.
 * @param url Absolute or relative URL.
 * @param fullUrls Value of `capture.fullUrls`.
 * @returns The URL to record.
 */
export function recordedUrl(url: string, fullUrls: boolean): string {
  const bare = url.replace(USER_INFO_PATTERN, "$1");
  return fullUrls ? bare : stripUrlQuery(bare);
}

/**
 * Drops the query string and fragment from a URL.
 * It cuts the string and does not parse a URL. A relative request target has no base URL.
 * @param url Absolute or relative URL.
 * @returns The URL up to the first "?" or "#".
 */
export function stripUrlQuery(url: string): string {
  const cut = url.search(/[?#]/);

  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Tests if the browser can reach the network. A host without navigator.onLine counts as online.
 * @returns False only when navigator.onLine is false.
 */
export function isOnline(): boolean {
  return (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false;
}

/** Resets the cached platform metadata for testing. */
export function resetPlatformCache(): void {
  cached = null;
}
