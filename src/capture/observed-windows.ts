// src/capture/observed-windows.ts
//
// Keeps the windows that the app asks the library to observe, for example a dockview popout
// whose code runs in this page. The list lives outside the runtime and the capture, so a window
// observed before configure() or across shutdown() gets attached when the click capture installs.
// This module is in the main graph, so it must not import the lazy click capture.

import { OBSERVED_WINDOWS_KEY, TELEMETRY_SDK_VERSION } from "../constants";

/** An installed click capture, as the registry sees it. */
export interface WindowObserver {
  /**
   * Starts listening in one window.
   * @param win The window.
   * @returns False when the window can't be observed, so the registry forgets it.
   */
  attach(win: Window): boolean;
  /**
   * Stops listening in one window.
   * @param win The window.
   */
  detach(win: Window): void;
}

/** The windows that the app observes now, and the click captures that are installed now. */
interface Registry {
  windows: Set<Window>;
  observers: Set<WindowObserver>;
}

/** The registry's global key. Its description must hold "window", because a spec clears it. */
const REGISTRY_KEY = Symbol.for(`${OBSERVED_WINDOWS_KEY}@${TELEMETRY_SDK_VERSION}`);

/**
 * Returns the page's registry. Two copies of one version share one runtime, so they share this
 * too. Otherwise a copy's observeWindow() would never reach the other copy's click capture.
 * @returns The registry.
 */
function registry(): Registry {
  const scope = globalThis as Record<symbol, Registry | undefined>;
  return (scope[REGISTRY_KEY] ??= { windows: new Set(), observers: new Set() });
}

/**
 * Checks whether a value can be a window. A window from another origin throws on the read, and
 * that's the expected answer. The fallback is true, so the capture reports it at attach.
 * @param value The value the app passed.
 * @returns True for an object with a document and an addEventListener function, or for one that
 * blocks the read.
 */
function windowLike(value: unknown): value is Window {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  try {
    const { document, addEventListener } = value as {
      document?: unknown;
      addEventListener?: unknown;
    };
    return (
      typeof document === "object" && document !== null && typeof addEventListener === "function"
    );
  } catch {
    return true;
  }
}

/**
 * Checks whether a window has closed. A window that throws on the read can't say, and that's the
 * expected answer. The fallback is false, so the capture tries it and reports it.
 * @param win The window.
 * @returns True if the window has closed.
 */
function isClosed(win: Window): boolean {
  try {
    return win.closed;
  } catch {
    return false;
  }
}

/** Drops each closed window. While clicks are off nothing hears its pagehide, so it'd stay. */
function pruneClosed(): void {
  const { windows } = registry();
  for (const win of windows) {
    if (isClosed(win)) {
      windows.delete(win);
    }
  }
}

/**
 * Attaches one window to one capture. A window that can't be observed leaves the list, so the
 * next install doesn't report it again.
 * @param observer The capture.
 * @param win The window.
 */
function attachTo(observer: WindowObserver, win: Window): void {
  if (!observer.attach(win)) {
    registry().windows.delete(win);
  }
}

/**
 * Removes a window from the list and from each installed capture.
 * @param win The window.
 */
export function forgetWindow(win: Window): void {
  const { windows, observers } = registry();
  if (!windows.delete(win)) {
    return;
  }

  for (const observer of observers) {
    observer.detach(win);
  }
}

/**
 * Returns the windows that the app observes now.
 * @returns A copy of the list, so a caller can hold it while the list changes.
 */
export function observedWindows(): Window[] {
  return [...registry().windows];
}

/**
 * Adds an installed click capture and attaches each window that's observed now.
 * @param observer The capture.
 * @returns Function that detaches each window from the capture and removes it.
 */
export function addWindowObserver(observer: WindowObserver): () => void {
  pruneClosed();
  const { windows, observers } = registry();
  observers.add(observer);
  for (const win of windows) {
    attachTo(observer, win);
  }

  return () => {
    observers.delete(observer);
    for (const win of windows) {
      observer.detach(win);
    }
  };
}

/**
 * Captures clicks in another window of this page, for example a popout whose code runs here.
 * The window gets click breadcrumbs, rage clicks and dead clicks, with the same rules as this
 * page. It gets no navigation capture. The window must have this page's origin. A window from
 * another origin reports `capture.install_failed` and records nothing. The result of
 * `window.open()` works at once, because the `pagehide` of its initial about:blank doesn't end
 * the capture.
 *
 * The library listens only while `capture.interactions` is on, and it keeps the window across
 * `shutdown()` and the next `configure()`. The window leaves at the stop function, at its
 * `pagehide` and when it closes. Observe it again after it reloads. A navigation to another
 * origin ends the capture there. This page's own window and a value that isn't a window do
 * nothing. A call never throws.
 * @param target The window to observe, for example the result of `window.open()`.
 * @returns Function that stops observing the window. A second call does nothing.
 */
export function observeWindow(target: Window): () => void {
  if ((target as unknown) === globalThis || !windowLike(target)) {
    return () => undefined;
  }

  pruneClosed();
  const { windows, observers } = registry();
  if (!windows.has(target)) {
    windows.add(target);
    for (const observer of observers) {
      attachTo(observer, target);
    }
  }

  return () => {
    forgetWindow(target);
  };
}
