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
  NET_CHANGE_ATTRIBUTES,
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

/** The page's initial document in a window that window.open() just made. */
const INITIAL_DOCUMENT_URL = "about:blank";

/**
 * Checks whether a node or a scroll target sits inside a live region. A removed node is detached
 * by the time the observer runs, so for it closest() can only test the node itself.
 * @param target The node, or the scroll's target.
 * @param live Selector of the live regions. "" marks nothing.
 * @returns True if the target is inside a live region.
 * @throws SyntaxError for a selector the browser can't parse. Call it inside a diagnostics guard.
 */
function insideLive(target: EventTarget | null, live: string): boolean {
  if (!live) {
    return false;
  }

  // A text change targets a Text node, and the document and the window have no closest().
  const element = isElement(target)
    ? target
    : ((target as Partial<Node> | null)?.parentElement ?? null);
  return Boolean(element?.closest(live));
}

/**
 * Checks whether an attribute or a text node now differs from a record's old value.
 * @param record An attributes or characterData change.
 * @returns True if the current value differs from the record's old value.
 */
function writeAnswers(record: MutationRecord): boolean {
  if (record.type === "characterData") {
    return (record.target as CharacterData).data !== record.oldValue;
  }

  // An attributes record always names its attribute.
  const { attributeName, attributeNamespace, oldValue } = record as MutationRecord & {
    attributeName: string;
  };
  return (record.target as Element).getAttributeNS(attributeNamespace, attributeName) !== oldValue;
}

/** What one observer batch did to one node. */
interface NodeChanges {
  /** The net-change attributes and the text data whose first record the batch has checked. */
  checked: Set<string>;
  /** True if a live element was added under this node. */
  added: boolean;
  /** True if a live element was removed from under this node. */
  removed: boolean;
}

/**
 * Checks whether one observer batch answers a click. A change inside a live region doesn't, and
 * neither does a write that keeps the old value. A batch that sets `name` or `type`, or a text's
 * data, and then puts the old value back doesn't either, because React rewrites an input that
 * way. Any other attribute answers at each write with a new value, even if a later write puts
 * the old one back, because a class or style change around a forced layout restarts an
 * animation, which the user sees. A grid that swaps a live element for a new one under the same
 * parent doesn't answer. A live element that only appears or only goes away does, because a
 * click can show or hide it.
 * @param records The batch.
 * @param live Selector of the live regions.
 * @returns True if a change in the batch answers the click.
 * @throws SyntaxError for a selector the browser can't parse. Call it inside a diagnostics guard.
 */
function batchAnswers(records: readonly MutationRecord[], live: string): boolean {
  const changes = new Map<Node, NodeChanges>();
  for (const record of records) {
    if (insideLive(record.target, live)) {
      continue;
    }

    let node = changes.get(record.target);
    if (!node) {
      node = { checked: new Set(), added: false, removed: false };
      changes.set(record.target, node);
    }

    if (record.type === "childList") {
      const nodes = [...record.addedNodes, ...record.removedNodes];
      if (!nodes.every((each) => isElement(each) && insideLive(each, live))) {
        return true;
      }
      // A browser can report one swap as one record or as two, so count the sides per parent.
      node.added ||= record.addedNodes.length > 0;
      node.removed ||= record.removedNodes.length > 0;
      continue;
    }

    if (record.type === "attributes") {
      // An attributes record always names its attribute.
      const { attributeName } = record as MutationRecord & { attributeName: string };
      if (!NET_CHANGE_ATTRIBUTES.includes(attributeName)) {
        if (writeAnswers(record)) {
          return true;
        }
        continue;
      }
    }

    // Only the first record's old value is the value before the batch. The namespace keeps an
    // SVG type apart from xlink:type, and a text's data has a null name, unlike any attribute.
    const key = JSON.stringify([record.attributeNamespace, record.attributeName]);
    if (node.checked.has(key)) {
      continue;
    }
    node.checked.add(key);
    if (writeAnswers(record)) {
      return true;
    }
  }

  return [...changes.values()].some((node) => node.added !== node.removed);
}

/**
 * Checks whether an open window still shows the about:blank that window.open() starts with. A
 * window that turned cross-origin throws, and that's the expected answer. The fallback is false,
 * so the caller forgets the window and no throw reaches the page from its pagehide.
 * @param win The window.
 * @returns True for an open window on its initial about:blank.
 */
function onInitialBlank(win: Window): boolean {
  try {
    return win.document.URL === INITIAL_DOCUMENT_URL && !win.closed;
  } catch {
    return false;
  }
}

/**
 * Reads a window's URL. A window that turned cross-origin throws, and that's the expected answer.
 * The fallback is "", so the URL counts as changed.
 * @param win The window.
 * @returns The URL, or "" when the window can't be read.
 */
function urlOf(win: Window): string {
  try {
    return win.location.href;
  } catch {
    return "";
  }
}

/**
 * Removes one listener from a window. A window that turned cross-origin throws, and that's the
 * expected answer. It holds no listener of ours, so the fallback is to remove nothing.
 * @param win The window.
 * @param type The event type.
 * @param listener The listener.
 * @param capture True for a capture-phase listener.
 */
function unlisten(win: Window, type: string, listener: EventListener, capture = false): void {
  try {
    win.removeEventListener(type, listener, capture);
  } catch {
    // Nothing to remove. The listener went with the document the window left.
  }
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
    // Restore history first. An observed window is another document, and a fault there mustn't
    // leave this page patched.
    for (const restore of this.restores.splice(0)) {
      restore();
    }
    this.unobserve?.();
    this.unobserve = undefined;

    this.stopDeadCheck?.();
    this.burst = { target: null, times: [], reported: false };
  }

  /** Records a click. The browser calls this directly, so a throw would be a page error. */
  private readonly onClick = (event: Event): void => {
    this.ctx.diagnostics.guard(
      "capture.record_failed",
      "The library could not record a click. It skips that click.",
      () => {
        this.recordClick(event);
      },
    );
  };

  /**
   * Rotates the trace context, records a click breadcrumb and runs the rage and dead click checks.
   * @param event The click.
   */
  private recordClick(event: Event): void {
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
  }

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
    const viewUrl = urlOf(view);
    const live = options.deadClickIgnoreSelector ?? DEAD_CLICK_IGNORE_SELECTOR;
    let responded = false;
    const observer = new MutationObserver((records) => {
      responded ||= this.answers(() => batchAnswers(records, live));
    });
    const onScroll = (event: Event): void => {
      responded ||= this.answers(() => !insideLive(event.target, live));
    };
    // A click in a popout can change this page, and a click here can change a popout.
    const views: Window[] = [];
    for (const each of [window, ...observedWindows()]) {
      try {
        // The old values let a same-value write count as no change.
        observer.observe(each.document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeOldValue: true,
          characterData: true,
          characterDataOldValue: true,
        });
        each.addEventListener("scroll", onScroll, { capture: true, passive: true });
        views.push(each);
      } catch {
        // A window that turned cross-origin throws, and that's the expected answer. The fallback
        // skips it and forgets it, because the library can't watch it anymore.
        forgetWindow(each);
      }
    }

    const stop = (): void => {
      // timer is declared after stop, but stop can only run once that line has executed.
      clearTimeout(timer);
      observer.disconnect();
      for (const each of views) {
        unlisten(each, "scroll", onScroll, true);
      }
      this.stopDeadCheck = undefined;
    };
    const timer = setTimeout(() => {
      stop();
      const moved = location.href !== pageUrl || urlOf(view) !== viewUrl;
      if (!responded && !moved && this.ctx.isActive?.() !== false) {
        this.ctx.logger.logEvent("ui.dead_click", { "click.action": action });
      }
    }, options.deadClickMs ?? DEAD_CLICK_MS);
    this.stopDeadCheck = stop;
  }

  /**
   * Runs one dead click test in a guard. A failed test counts as an answer, so a fault can't make
   * up a dead click. The browser calls the observer and the listener directly, so a throw would
   * be a page error.
   * @param test Returns true if a change answers the click.
   * @returns The test's result, or true if it threw.
   */
  private answers(test: () => boolean): boolean {
    return (
      this.ctx.diagnostics.guard(
        "capture.record_failed",
        "The library could not check a page change for a dead click. It counts the change as a response.",
        test,
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
    unlisten(win, "click", this.onClick, true);
    unlisten(win, "pagehide", this.onViewHide);
  }

  /** Forgets an observed window when its page goes away, so the library doesn't hold it. */
  private readonly onViewHide = (event: Event): void => {
    const win = event.currentTarget as Window;
    // window.open(url) starts on about:blank and fires pagehide there. Then it loads a page of
    // this origin into the same window, which keeps our listeners, so forgetting it would lose it.
    if (onInitialBlank(win)) {
      return;
    }

    forgetWindow(win);
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
