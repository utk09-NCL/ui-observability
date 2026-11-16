// src/capture/unclean-exit.ts
//
// Detects a page in this tab that ended without a clean close, for example after a crash. The
// top document keeps a marker in sessionStorage and a clean close removes it, so if the tab's
// next page finds a marker, it reports it.

import { ALIVE_KEY, ALIVE_UPDATE_MS } from "../constants";
import type { Capture, CaptureContext } from "./types";

/** Marker left by a page that is alive. */
interface AliveMarker {
  /** The page's session id. */
  sessionId: string;
  /** When the marker was last updated, in epoch milliseconds. */
  at: number;
  /** The page's visibility at the last update. */
  visibility: string;
}

/** A document with the flag the browser sets on a page it discarded to free memory. */
interface DiscardDocument {
  wasDiscarded?: boolean;
}

/**
 * Reads a marker from its sessionStorage text.
 * @param text Stored text, or null when there is no marker.
 * @returns The marker, or null if there is none or it has the wrong shape.
 * @throws SyntaxError for text that isn't JSON. The caller reports it.
 */
function readMarker(text: string | null): AliveMarker | null {
  const value: unknown = text === null ? null : JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { sessionId, at, visibility } = value as Partial<Record<keyof AliveMarker, unknown>>;
  const valid =
    typeof sessionId === "string" && Number.isFinite(at) && typeof visibility === "string";

  return valid ? { sessionId, at: at as number, visibility } : null;
}

/** Reports the previous page's unclean exit, and maintains this page's marker. */
export class UncleanExitCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "uncleanExit";

  /** Prevents duplicate listener registration. */
  private installed = false;

  /** Timer that updates the marker. */
  private timer: ReturnType<typeof setInterval> | undefined;

  /** True after pagehide. Needed because the browser fires visibilitychange after pagehide. */
  private closing = false;

  /**
   * @param ctx Capture context with the config, diagnostics, logger and session id.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Reports the previous page's marker once, then starts maintaining this page's own. */
  install(): void {
    // Only the top document keeps the marker, because a same-origin frame shares its
    // sessionStorage.
    if (this.installed || typeof document === "undefined" || window.parent !== window) {
      return;
    }

    // The marker holds the session id, and memory identity writes nothing to the device.
    if (this.ctx.config.identity === "memory") {
      this.ctx.diagnostics.report(
        "capture.install_failed",
        'capture.uncleanExit needs sessionStorage. identity: "memory" turns it off.',
      );
      return;
    }
    this.installed = true;

    if (!this.ctx.once.uncleanExit) {
      this.ctx.once.uncleanExit = true;
      // A popup copies its live opener's sessionStorage, so that marker isn't a crash.
      if (!window.opener) {
        this.reportPrevious();
      }
    }

    this.mark();
    addEventListener("pagehide", this.onPageHide);
    addEventListener("pageshow", this.onPageShow);
    document.addEventListener("visibilitychange", this.mark);
    this.timer = setInterval(this.mark, ALIVE_UPDATE_MS);
  }

  /** Removes the listeners, the timer and the marker, since the capture stopped without a crash. */
  uninstall(): void {
    if (!this.installed) {
      return;
    }
    this.installed = false;

    removeEventListener("pagehide", this.onPageHide);
    removeEventListener("pageshow", this.onPageShow);
    document.removeEventListener("visibilitychange", this.mark);
    clearInterval(this.timer);
    this.clear();
  }

  /** Logs WARN `ui.unclean_exit` if this tab's previous page left its marker behind. */
  private reportPrevious(): void {
    const marker = this.ctx.diagnostics.guard(
      "storage.unavailable",
      "The library could not read the alive marker in sessionStorage.",
      () => readMarker(sessionStorage.getItem(ALIVE_KEY)),
    );
    if (!marker) {
      return;
    }

    this.ctx.logger.warn("ui.unclean_exit", {
      "exit.session_id": marker.sessionId,
      "exit.last_seen_ms": marker.at,
      "exit.visibility": marker.visibility,
      "exit.discarded": (document as DiscardDocument).wasDiscarded === true,
    });
  }

  /** Writes this page's marker with the current time and visibility. */
  private readonly mark = (): void => {
    if (this.closing) {
      return;
    }

    const marker: AliveMarker = {
      sessionId: this.ctx.sessionId(),
      at: Date.now(),
      visibility: document.visibilityState,
    };

    this.ctx.diagnostics.guard(
      "storage.unavailable",
      "The library could not write the alive marker to sessionStorage.",
      () => {
        sessionStorage.setItem(ALIVE_KEY, JSON.stringify(marker));
      },
    );
  };

  /** Removes this page's marker. */
  private clear(): void {
    this.ctx.diagnostics.guard(
      "storage.unavailable",
      "The library could not remove the alive marker from sessionStorage.",
      () => {
        sessionStorage.removeItem(ALIVE_KEY);
      },
    );
  }

  /** A clean close removes the marker. The page may still live on in the back-forward cache. */
  private readonly onPageHide = (): void => {
    this.closing = true;
    this.clear();
  };

  /** A page that comes back from the back-forward cache is alive again. */
  private readonly onPageShow = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted) {
      this.closing = false;
      this.mark();
    }
  };
}
