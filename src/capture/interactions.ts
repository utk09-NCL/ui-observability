// src/capture/interactions.ts
//
// Captures clicks and in-page navigations as breadcrumbs and trace boundaries.

import { ARIA_LABEL_MAX_CHARS, CLICK_TEXT_MAX_CHARS, SELECTOR_MAX_CLASSES } from "../constants";
import type { Capture, CaptureContext } from "./types";

/**
 * Generates a concise CSS selector for an element, prioritizing test IDs, IDs, aria-labels, and classes.
 * @param element Target DOM element.
 * @returns Generated CSS selector string.
 */
function describeElement(element: Element | null): string {
  if (element === null) {
    return "unknown";
  }

  const tag = element.tagName.toLowerCase();

  const testId = element.getAttribute("data-testid") ?? element.getAttribute("data-test-id");
  if (testId !== null) {
    return `[data-testid="${testId}"]`;
  }
  if (element.id !== "") {
    return `#${element.id}`;
  }

  const label = element.getAttribute("aria-label");
  if (label !== null) {
    return `${tag}[aria-label="${label.slice(0, ARIA_LABEL_MAX_CHARS)}"]`;
  }

  // Read through getAttribute: an SVG element's `className` is an
  // SVGAnimatedString at runtime, and slicing it would throw.
  const classAttribute = element.getAttribute("class")?.trim() ?? "";
  if (classAttribute === "") {
    return tag;
  }

  const classes = classAttribute.split(/\s+/).slice(0, SELECTOR_MAX_CLASSES).join(".");
  return `${tag}.${classes}`;
}

/**
 * The two History members this module replaces, typed as properties rather than
 * methods so the originals can be held unbound. Holding a bound copy instead
 * makes uninstall restore a different function than it replaced, and repeated
 * install cycles wrap a bind over the previous bind.
 */
interface HistoryMethods {
  pushState: (this: History, ...args: never[]) => void;
  replaceState: (this: History, ...args: never[]) => void;
}

/**
 * The History object, typed for holding its methods unbound.
 * @returns The global history.
 */
function historyMethods(): HistoryMethods {
  return history;
}

/** Captures user click interactions and single-page navigation transitions. */
export class InteractionCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "interactions";

  /** Prevents duplicate listener registration. */
  private installed = false;

  /** Unpatched History.pushState implementation. */
  private originalPushState: HistoryMethods["pushState"] | null = null;

  /** Unpatched History.replaceState implementation. */
  private originalReplaceState: HistoryMethods["replaceState"] | null = null;

  /** Tracked URL prior to the latest navigation event. */
  private lastUrl = "";

  /**
   * @param ctx Capture context containing configuration, diagnostics, logger, breadcrumbs, and tracing.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Registers click listeners and patches history navigation APIs. */
  install(): void {
    if (this.installed || typeof document === "undefined") {
      return;
    }
    this.installed = true;
    this.lastUrl = location.href;

    if (this.ctx.config.capture.interactions) {
      // Uses capture phase to observe clicks before event propagation is stopped.
      addEventListener("click", this.onClick, true);
    }
    if (this.ctx.config.capture.navigation) {
      this.installHistory();
      addEventListener("popstate", this.onNavigate);
      addEventListener("hashchange", this.onNavigate);
    }
  }

  /** Removes interaction listeners and restores native history methods. */
  uninstall(): void {
    if (!this.installed) {
      return;
    }
    this.installed = false;

    removeEventListener("click", this.onClick, true);
    removeEventListener("popstate", this.onNavigate);
    removeEventListener("hashchange", this.onNavigate);

    if (this.originalPushState) {
      historyMethods().pushState = this.originalPushState;
    }
    if (this.originalReplaceState) {
      historyMethods().replaceState = this.originalReplaceState;
    }
    this.originalPushState = null;
    this.originalReplaceState = null;
  }

  /** Rotates trace context and records a click breadcrumb. */
  private readonly onClick = (event: Event): void => {
    const target = event.target;
    const selector = describeElement(target instanceof Element ? target : null);
    const text =
      target instanceof HTMLElement ? target.innerText.trim().slice(0, CLICK_TEXT_MAX_CHARS) : "";

    // A click starts a new logical operation, so everything it causes shares one
    // trace id. Without the rotation a click and its five API calls cannot be
    // pulled back as one query.
    this.ctx.tracing.rotate("interaction");
    this.ctx.breadcrumbs.push({
      t: Date.now(),
      category: "click",
      message: selector,
      data: text === "" ? undefined : { text },
    });
  };

  /** Rotates trace context and records a navigation breadcrumb and event on URL changes. */
  private readonly onNavigate = (): void => {
    const from = this.lastUrl;
    const to = location.href;
    if (from === to) {
      return;
    }
    this.lastUrl = to;

    this.ctx.tracing.rotate("navigation");
    this.ctx.breadcrumbs.push({
      t: Date.now(),
      category: "navigation",
      message: `${from} -> ${to}`,
    });

    // Only the previous URL is carried: the record builder stamps the current
    // one as `page.url`. Sending the new URL as `url.full` would make a
    // navigation look like an HTTP request to that address.
    this.ctx.logger.logEvent("NAVIGATION", { "page.url.previous": from });
  };

  /** Patches History.pushState and replaceState to observe programmatic navigations. */
  private installHistory(): void {
    if (typeof history === "undefined" || this.originalPushState) {
      return;
    }

    // Held unbound and called through apply. Reading History.prototype instead
    // skips whatever a router already installed on the instance, and leaves
    // uninstall writing a permanent own property where there was none.
    const target = historyMethods();
    const originalPushState = target.pushState;
    const originalReplaceState = target.replaceState;
    this.originalPushState = originalPushState;
    this.originalReplaceState = originalReplaceState;
    const onNavigate = this.onNavigate;

    target.pushState = function (this: History, ...args: never[]): void {
      originalPushState.apply(this, args);
      // Queued: location.href is only updated once the call returns, so reading
      // it synchronously reports the previous URL as the new one.
      queueMicrotask(onNavigate);
    };

    target.replaceState = function (this: History, ...args: never[]): void {
      originalReplaceState.apply(this, args);
      queueMicrotask(onNavigate);
    };
  }
}
