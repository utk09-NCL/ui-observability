// src/capture/unclean-exit.ts
//
// Finds a page of this tab that stopped without a clean close, for example after a crash. The top
// document keeps a marker in sessionStorage. A clean close removes it. The next page of the tab
// reports a marker that it finds.

import { ALIVE_KEY, ALIVE_UPDATE_MS } from "../constants";
import type { Capture, CaptureContext } from "./types";

/** Marker of a page that is alive. */
interface AliveMarker {
  /** Session id of the page. */
  sessionId: string;
  /** Epoch time in milliseconds of the last update. */
  at: number;
  /** Visibility of the page at the last update. */
  visibility: string;
}

/** Document with the flag of a page that the browser discarded to free memory. */
interface DiscardDocument {
  wasDiscarded?: boolean;
}

/**
 * Reads a marker from its sessionStorage text.
 * @param text Stored text, or null without a marker.
 * @returns The marker, or null for no marker or a marker of another shape.
 * @throws SyntaxError for text that is not JSON. The caller reports it.
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

/** Reports the unclean exit of the previous page, and keeps the marker of this page. */
export class UncleanExitCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "uncleanExit";

  /** Prevents duplicate listener registration. */
  private installed = false;

  /** Timer that updates the marker. */
  private timer: ReturnType<typeof setInterval> | undefined;

  /** True after pagehide. The browser fires visibilitychange after pagehide. */
  private closing = false;

  /**
   * @param ctx Capture context with the config, diagnostics, logger and session id.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Reports the marker of the previous page one time. Then it keeps the marker of this page. */
  install(): void {
    // Only the top document keeps the marker. A same-origin frame shares its sessionStorage.
    if (this.installed || typeof document === "undefined" || window.parent !== window) {
      return;
    }

    // The marker holds the session id. Memory identity writes nothing to the device.
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
      // A popup copies the sessionStorage of its live opener. That marker is not a crash.
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

  /** Removes the listeners, the timer and the marker. The capture stopped with no crash. */
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

  /** Logs WARN `ui.unclean_exit` when the previous page of this tab left its marker. */
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

  /** Writes the marker of this page with the time and the visibility of now. */
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

  /** Removes the marker of this page. */
  private clear(): void {
    this.ctx.diagnostics.guard(
      "storage.unavailable",
      "The library could not remove the alive marker from sessionStorage.",
      () => {
        sessionStorage.removeItem(ALIVE_KEY);
      },
    );
  }

  /** A clean close removes the marker. The back-forward cache can keep the page. */
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
