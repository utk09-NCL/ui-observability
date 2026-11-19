import { allowInWindow, type StormWindow } from "./storm";
import type { Capture, CaptureContext, CaptureOnce } from "./types";

/** Records page state changes, each with how long the previous state lasted. */
export class LifecycleCapture implements Capture {
  readonly name = "lifecycle";

  private installed = false;

  private phase: NonNullable<CaptureOnce["lifecycle"]> = { state: "", enteredAt: 0 };

  private readonly window: StormWindow = { start: 0, count: 0 };

  constructor(private readonly ctx: CaptureContext) {}

  /** Installs the document and back-forward cache listeners. */
  install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;
    this.ctx.once.lifecycle ??= { state: "", enteredAt: performance.now() };
    this.phase = this.ctx.once.lifecycle;
    document.addEventListener("visibilitychange", this.onVisibility);
    document.addEventListener("freeze", this.onFreeze);
    document.addEventListener("resume", this.onResume);
    addEventListener("pageshow", this.onPageShow);
    this.onVisibility();
  }

  /** Removes all listeners. */
  uninstall(): void {
    this.installed = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    document.removeEventListener("freeze", this.onFreeze);
    document.removeEventListener("resume", this.onResume);
    removeEventListener("pageshow", this.onPageShow);
  }

  private readonly onVisibility = (): void => {
    this.transition(document.visibilityState === "hidden" ? "hidden" : "visible");
  };

  private readonly onFreeze = (): void => {
    this.transition("frozen");
  };

  private readonly onResume = (): void => {
    this.transition("resumed");
  };

  private readonly onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      this.transition("restored");
    }
  };

  /** Updates the state even when the rate limit drops its event. */
  private transition(state: string): void {
    if (!this.installed || state === this.phase.state) {
      return;
    }

    const now = performance.now();
    const previous = this.phase.state;
    const duration = Math.max(0, now - this.phase.enteredAt);
    this.phase.state = state;
    this.phase.enteredAt = now;

    const { captureLimits } = this.ctx.config;
    if (
      this.ctx.isActive?.() === false ||
      !allowInWindow(
        this.window,
        captureLimits.lifecyclePerWindow,
        this.ctx.diagnostics,
        "lifecycle events",
        captureLimits.windowMs,
      )
    ) {
      return;
    }

    this.ctx.diagnostics.guard(
      "capture.record_failed",
      "The library could not record a lifecycle event.",
      () => {
        this.ctx.logger.logEvent("ui.lifecycle", {
          "lifecycle.state": state,
          "lifecycle.previous_state": previous,
          "lifecycle.duration_ms": duration,
        });
      },
    );
  }
}
