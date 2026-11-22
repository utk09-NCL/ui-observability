// src/capture/interactions.ts
//
// Captures clicks and in-page navigations as breadcrumbs and trace boundaries. Also detects
// rage clicks and dead clicks.

import {
  ACTION_ATTRIBUTE_DEFAULT,
  ARIA_LABEL_MAX_CHARS,
  CLICK_TEXT_MAX_CHARS,
  DEAD_CLICK_CONTROLS,
  DEAD_CLICK_IGNORE_SELECTOR,
  DEAD_CLICK_MS,
  IGNORE_SELECTOR,
  RAGE_CLICK_COUNT,
  RAGE_CLICK_WINDOW_MS,
  SELECTOR_MAX_CLASSES,
} from "../constants";
import type { InteractionOptions } from "../models/config";
import { patch } from "../utils/patch";
import { recordedUrl } from "../utils/platform";
import { addWindowObserver, forgetWindow, observedWindows } from "./observed-windows";
import type { Capture, CaptureContext } from "./types";

/** Links that open elsewhere. The page shows no response, but the click isn't dead. */
const LEAVING_LINKS = 'a[target="_blank"], a[download]';

/** An element's nodeType. Node.ELEMENT_NODE won't do, because another window has its own Node. */
const ELEMENT_NODE = 1;

/**
 * Checks whether a value is an element of any window. instanceof fails for a popout's element,
 * because each window has its own Element class.
 * @param value An event or mutation target.
 * @returns True for an element.
 */
function isElement(value: unknown): value is Element {
  return (value as Partial<Node> | null)?.nodeType === ELEMENT_NODE;
}

/**
 * Builds a short CSS selector for an element. Prefers the test ID, then the ID, then the
 * aria-label, then the class names.
 * @param element Target DOM element.
 * @returns The selector.
 */
function describeElement(element: Element): string {
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

  // Read the class through getAttribute. On an SVG element, `className` is an
  // SVGAnimatedString, and slicing it throws.
  const classAttribute = element.getAttribute("class")?.trim() ?? "";
  if (classAttribute === "") {
    return tag;
  }

  const classes = classAttribute.split(/\s+/).slice(0, SELECTOR_MAX_CLASSES).join(".");
  return `${tag}.${classes}`;
}

/**
 * The two History members this module replaces. They are declared as properties, not
 * methods, so the original functions stay unbound. With a bound copy, uninstall would
 * restore a different function from the one it replaced, and every install cycle would
 * stack one more bind on top of the last.
 */
interface HistoryMethods {
  pushState: (this: History, ...args: never[]) => void;
  replaceState: (this: History, ...args: never[]) => void;
}

/**
 * Returns the History object, typed so that its methods stay unbound.
 * @returns The global history.
 */
function historyMethods(): HistoryMethods {
  return history;
}

/** Captures user clicks and single-page navigations. */
export class InteractionCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "interactions";

  /** Prevents duplicate listener registration. */
  private installed = false;

  /** Restore functions for the history wrappers. */
  private readonly restores: (() => void)[] = [];

  /** The URL before the latest navigation. */
  private lastUrl = "";

  /** The element of the current click burst, and when each of its clicks happened. */
  private burst: { target: Element | null; times: number[]; reported: boolean } = {
    target: null,
    times: [],
    reported: false,
  };

  /** Stops the dead click check that is running now. */
  private stopDeadCheck: (() => void) | undefined;

  /** Detaches the observed windows. Set while clicks are captured. */
  private unobserve: (() => void) | undefined;

  /**
   * @param ctx Capture context: configuration, diagnostics, logger, breadcrumbs and tracing.
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
      // In the capture phase we see the click before a page handler can stop propagation.
      addEventListener("click", this.onClick, true);
      // The app's observed windows outlive this capture, so one observed before the install
      // gets attached here.
      this.unobserve = addWindowObserver({
        attach: (win) => this.attachView(win),
        detach: (win) => {
          this.detachView(win);
        },
      });
    }
    if (this.ctx.config.capture.navigation) {
      this.installHistory();
      addEventListener("popstate", this.onNavigate);
      addEventListener("hashchange", this.onNavigate);
    }
  }

  /**
   * Removes the interaction listeners and restores every history method that still holds our
   * wrapper. A wrapper that another script wrapped again stays in place and records nothing.
   */
  uninstall(): void {
    if (!this.installed) {
      return;
    }
    this.installed = false;

    removeEventListener("click", this.onClick, true);
    removeEventListener("popstate", this.onNavigate);
    removeEventListener("hashchange", this.onNavigate);
    this.unobserve?.();
    this.unobserve = undefined;

    for (const restore of this.restores.splice(0)) {
      restore();
    }

    this.stopDeadCheck?.();
    this.burst = { target: null, times: [], reported: false };
  }

  /** Rotates the trace context and records a click breadcrumb. */
  private readonly onClick = (event: Event): void => {
    if (this.ctx.isActive?.() === false) {
      return;
    }
    const target = event.target;
    if (!isElement(target)) {
      return;
    }
    const settings = this.ctx.config.capture.interactions;
    const options = typeof settings === "object" ? settings : {};
    const ignore = options.ignoreSelector === undefined ? IGNORE_SELECTOR : options.ignoreSelector;
    if (ignore && target.closest(ignore)) {
      return;
    }
    // A missing or empty attribute gives "", and the message is then "unknown-click".
    const attribute = options.actionAttribute ?? ACTION_ATTRIBUTE_DEFAULT;
    const action = target.closest(`[${attribute}]`)?.getAttribute(attribute) ?? "";
    const message = (action || "unknown-click").slice(0, this.ctx.config.limits.maxBodyChars);
    const data: Record<string, unknown> = {};
    if (options.selector) {
      data.selector = describeElement(target);
    }
    if (options.text) {
      data.text = target.textContent.trim().slice(0, options.maxTextChars ?? CLICK_TEXT_MAX_CHARS);
    }
    this.ctx.tracing.rotate("interaction");
    this.ctx.breadcrumbs.push({
      t: Date.now(),
      category: "click",
      message,
      data: Object.keys(data).length > 0 ? data : undefined,
    });

    if (options.rageClicks) {
      this.countRage(target, message, options);
    }
    if (
      options.deadClicks &&
      target.closest(`${DEAD_CLICK_CONTROLS}, [${attribute}]`) &&
      !target.closest(LEAVING_LINKS)
    ) {
      // The listener sits on the window that got the click, the page's own or an observed one.
      this.watchDead(message, options, event.currentTarget as Window);
    }
  };

  /**
   * Counts the clicks on one element and records `ui.rage_click` once per burst.
   * @param target Clicked element.
   * @param action The click's action name.
   * @param options Interaction options.
   */
  private countRage(target: Element, action: string, options: InteractionOptions): void {
    const now = Date.now();
    const windowMs = options.rageClickWindowMs ?? RAGE_CLICK_WINDOW_MS;
    const count = options.rageClickCount ?? RAGE_CLICK_COUNT;
    const times =
      this.burst.target === target ? this.burst.times.filter((t) => now - t < windowMs) : [];
    // A burst only ends once no click is left in the window, so clicks that keep sliding
    // through it don't fire a second event.
    const reported = times.length > 0 && this.burst.reported;
    times.push(now);
    const reached = times.length >= count;
    this.burst = { target, times, reported: reported || reached };

    if (reached && !reported) {
      this.ctx.logger.logEvent("ui.rage_click", { "click.action": action, "click.count": count });
    }
  }

  /**
   * Watches the page and each observed window after a click on a control. If there's no DOM
   * change, URL change or scroll within `deadClickMs`, it records `ui.dead_click`. Only one
   * check runs at a time.
   * @param action The click's action name.
   * @param options Interaction options.
   * @param view The window that got the click. Its URL change answers the click too.
   */
  private watchDead(action: string, options: InteractionOptions, view: Window): void {
    if (this.stopDeadCheck || typeof MutationObserver === "undefined") {
      return;
    }

    const pageUrl = location.href;
    const viewUrl = view.location.href;
    const live = options.deadClickIgnoreSelector ?? DEAD_CLICK_IGNORE_SELECTOR;
    let responded = false;
    const observer = new MutationObserver((records) => {
      responded ||= records.some((record) => this.answersClick(record.target, live));
    });
    const onScroll = (event: Event): void => {
      responded ||= this.answersClick(event.target, live);
    };
    // A click in a popout can change this page, and a click here can change a popout.
    const views = [window, ...observedWindows()];
    for (const each of views) {
      // An observed window is another document, so a fault there mustn't fail the click handler.
      this.ctx.diagnostics.guard(
        "capture.record_failed",
        "The library could not watch a window for a dead click. The check skips that window.",
        () => {
          observer.observe(each.document, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          each.addEventListener("scroll", onScroll, { capture: true, passive: true });
        },
      );
    }

    const stop = (): void => {
      // timer is declared after stop, but stop can only run once that line has executed.
      clearTimeout(timer);
      observer.disconnect();
      for (const each of views) {
        each.removeEventListener("scroll", onScroll, true);
      }
      this.stopDeadCheck = undefined;
    };
    const timer = setTimeout(() => {
      stop();
      const moved = location.href !== pageUrl || view.location.href !== viewUrl;
      if (!responded && !moved && this.ctx.isActive?.() !== false) {
        this.ctx.logger.logEvent("ui.dead_click", { "click.action": action });
      }
    }, options.deadClickMs ?? DEAD_CLICK_MS);
    this.stopDeadCheck = stop;
  }

  /**
   * Checks whether a DOM change or a scroll answers a click. One inside a live region, such as a
   * ticking price cell, doesn't. A failed match counts as an answer, so a fault can't make up a
   * dead click.
   * @param target The changed node, or the scroll's target.
   * @param live Selector of the live regions. "" makes every change an answer.
   * @returns True if the change answers the click.
   */
  private answersClick(target: EventTarget | null, live: string): boolean {
    if (!live) {
      return true;
    }

    // A text change targets a Text node, and the document and the window have no closest().
    // Read the node type, because a popout's nodes fail instanceof.
    const element = isElement(target)
      ? target
      : ((target as Partial<Node> | null)?.parentElement ?? null);
    // The browser calls the observer and the listener directly, so a throw is a page error.
    return (
      this.ctx.diagnostics.guard(
        "capture.record_failed",
        "The library could not check a page change for a dead click. It counts the change as a response.",
        () => !element?.closest(live),
      ) ?? true
    );
  }

  /**
   * Starts listening for clicks in an observed window.
   * @param win The window.
   * @returns False for a window from another origin, after it reports the window.
   */
  private attachView(win: Window): boolean {
    try {
      // Only a window of this origin has a readable document. Reading it first means a window
      // from another origin throws before it gets a listener.
      const _sameOrigin = win.document;
      win.addEventListener("click", this.onClick, true);
      win.addEventListener("pagehide", this.onViewHide);
      return true;
    } catch {
      this.ctx.diagnostics.report(
        "capture.install_failed",
        "The library cannot observe a window from another origin. It captures no clicks there.",
      );
      return false;
    }
  }

  /**
   * Stops listening in an observed window. A running dead click check stops too, without a
   * record, because it holds a listener in this window. A window that leaves during the check
   * has most often answered the click, for example a popout that docks back into the page.
   * @param win The window.
   */
  private detachView(win: Window): void {
    this.stopDeadCheck?.();
    win.removeEventListener("click", this.onClick, true);
    win.removeEventListener("pagehide", this.onViewHide);
  }

  /** Forgets an observed window when its page goes away, so the library doesn't hold it. */
  private readonly onViewHide = (event: Event): void => {
    forgetWindow(event.currentTarget as Window);
  };

  /** On a URL change, rotates the trace context and records a breadcrumb and an event. */
  private readonly onNavigate = (): void => {
    const from = this.lastUrl;
    const to = location.href;
    if (from === to) {
      return;
    }
    this.lastUrl = to;
    if (this.ctx.isActive?.() === false) {
      return;
    }

    // The comparison above uses the full URL, so a query-only change still counts as a
    // navigation. The record doesn't keep the query unless you set fullUrls.
    const full = this.ctx.config.capture.fullUrls;
    const { urlTransform } = this.ctx.config.capture;
    const fromUrl = recordedUrl(from, full, urlTransform, this.ctx.diagnostics);
    const toUrl = recordedUrl(to, full, urlTransform, this.ctx.diagnostics);

    this.ctx.tracing.rotate("navigation");
    this.ctx.breadcrumbs.push({
      t: Date.now(),
      category: "navigation",
      message: `${fromUrl} -> ${toUrl}`,
    });

    // The event carries only the previous URL, and the record builder adds the current one as
    // `page.url`. Putting the new URL in `url.full` would make a navigation look like an HTTP
    // request.
    this.ctx.logger.logEvent("NAVIGATION", { "page.url.previous": fromUrl });
  };

  /** Patches History.pushState and replaceState to observe programmatic navigations. */
  private installHistory(): void {
    if (typeof history === "undefined") {
      return;
    }

    // Wrap the instance, not History.prototype. Reading from the prototype would skip a patch
    // that a router installed on the instance. patch keeps the originals unbound.
    const target = historyMethods();
    const onNavigate = this.onNavigate;
    // Uninstall clears the flag, so a wrapper that stays in place only calls the original.
    let active = true;

    const restorePushState = patch(
      target,
      "pushState",
      (original) =>
        function (this: History, ...args: never[]): void {
          original.apply(this, args);
          // Queue the handler. The browser only updates location.href after the call returns,
          // so a synchronous read would report the previous URL as the new one.
          if (active) {
            queueMicrotask(onNavigate);
          }
        },
    );

    const restoreReplaceState = patch(
      target,
      "replaceState",
      (original) =>
        function (this: History, ...args: never[]): void {
          original.apply(this, args);
          if (active) {
            queueMicrotask(onNavigate);
          }
        },
    );

    this.restores.push(() => {
      active = false;
      restorePushState();
      restoreReplaceState();
    });
  }
}
