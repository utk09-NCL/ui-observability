// src/capture/console.ts
//
// Records the app's own console calls, because third-party code often reports a fault only there.

import { CONSOLE_BREADCRUMB_MAX_CHARS } from "../constants";
import type { CapturedConsoleMethod } from "../models/config";
import { type ErrorLike, isErrorLike } from "../utils/error-like";
import { isLibraryConsole, runAsLibraryConsole } from "../utils/library-console";
import { patch } from "../utils/patch";
import { truncate } from "../utils/sanitize";
import { allowInWindow, type StormWindow } from "./storm";
import type { Capture, CaptureContext } from "./types";

/** The console methods this capture can wrap. */
const METHODS: readonly CapturedConsoleMethod[] = ["error", "warn", "info", "log"];

/** Methods that `capture.console: true` wraps. */
const DEFAULT_METHODS: readonly CapturedConsoleMethod[] = ["error", "warn"];

/** Signature of a console method. */
type ConsoleFn = (...args: unknown[]) => void;

/** A wrapper's record function. Uninstall sets it to null. */
interface Target {
  /** Records one call, or null after uninstall. */
  record: ((args: unknown[]) => void) | null;
}

/** A wrapper's target, plus the function that undoes its patch. */
interface Wrapped {
  /** The wrapper's target. */
  target: Target;
  /** Puts the original back if the method still holds the wrapper. Returns true if it did. */
  restore: () => boolean;
}

/**
 * Builds a wrapper that calls the original first, then the target.
 * The wrapper doesn't close over the capture, so one that stays in place keeps no runtime alive.
 * @param original The method that was in place before the wrap.
 * @param target The wrapper's target.
 * @returns The wrapper.
 */
function makeWrapper(original: ConsoleFn, target: Target): ConsoleFn {
  return (...args) => {
    // Call the original first, so devtools shows the same text even when the record fails.
    Reflect.apply(original, console, args);

    // Skip the lines the library itself prints.
    if (isLibraryConsole()) {
      return;
    }

    target.record?.(args);
  };
}

/** Wraps the selected console methods and records every call as a record or a breadcrumb. */
export class ConsoleCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "console";

  /** Active wrappers. A wrapper that isn't in this map only calls the original. */
  private readonly wrapped = new Map<CapturedConsoleMethod, Wrapped>();

  /** Guards against wrapping a method twice. */
  private installed = false;

  /** This capture's own rate limit, so console noise can't eat the error capture's allowance. */
  private readonly window: StormWindow = { start: 0, count: 0 };

  /**
   * @param ctx Capture context: configuration, diagnostics, logger and breadcrumbs.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Wraps every selected method. */
  install(): void {
    // Some worker realms don't define console, so guard against a missing one.
    if (this.installed || typeof console === "undefined") {
      return;
    }
    this.installed = true;

    for (const method of this.readMethods()) {
      this.wrap(method);
    }
  }

  /** Restores every method that still holds this capture's wrapper. */
  uninstall(): void {
    if (!this.installed) {
      return;
    }
    this.installed = false;

    for (const [method, { target, restore }] of this.wrapped) {
      target.record = null;

      if (restore()) {
        continue;
      }

      // Restoring here would remove the other script's wrapper, so leave it. Our wrapper now
      // only calls the original.
      this.ctx.diagnostics.report(
        "capture.install_failed",
        `Another script wrapped console.${method} after the library. The library leaves that wrapper in place.`,
      );
    }

    this.wrapped.clear();
  }

  /**
   * Reads the methods from the configuration and reports any value it can't use.
   * @returns Methods to wrap, with no duplicates.
   */
  private readMethods(): readonly CapturedConsoleMethod[] {
    const value: unknown = this.ctx.config.capture.console;

    if (value === true) {
      return DEFAULT_METHODS;
    }

    if (
      Array.isArray(value) &&
      value.every((method: unknown) => METHODS.includes(method as CapturedConsoleMethod))
    ) {
      return [...new Set(value as CapturedConsoleMethod[])];
    }

    this.ctx.diagnostics.report(
      "config.invalid",
      'capture.console must be true, false or a list of "error", "warn", "info" and "log". The console capture is off.',
    );
    return [];
  }

  /**
   * Replaces one console method with a wrapper that calls the original first.
   * @param method Console method to wrap.
   */
  private wrap(method: CapturedConsoleMethod): void {
    const target: Target = {
      record: (args) => {
        // The scope keeps a console call inside the record path from being captured again.
        runAsLibraryConsole(() => {
          this.ctx.diagnostics.guard(
            "capture.record_failed",
            `The library could not record a console.${method} call.`,
            () => {
              this.record(method, args);
            },
          );
        });
      },
    };

    // patch keeps the unbound method, so uninstall restores the same function, not a bound copy.
    const restore = patch(console, method, (original) => makeWrapper(original, target));
    this.wrapped.set(method, { target, restore });
  }

  /**
   * Records one console call.
   * @param method The console method that was called.
   * @param args The call's arguments.
   */
  private record(method: CapturedConsoleMethod, args: unknown[]): void {
    // Duck typing also finds an error from another realm, which fails `instanceof Error`.
    const errorAt = args.findIndex((arg) => isErrorLike(arg));
    const textAt = args.findIndex((arg) => typeof arg === "string");
    const error = args[errorAt] as ErrorLike | undefined;
    const message = (args[textAt] as string | undefined) ?? error?.message ?? `console.${method}`;

    if (method === "info" || method === "log") {
      this.ctx.breadcrumbs.push({
        t: Date.now(),
        category: "console",
        message: truncate(message, CONSOLE_BREADCRUMB_MAX_CHARS),
        data: { "console.method": method },
      });
      return;
    }

    const { diagnostics, logger } = this.ctx;

    if (
      !allowInWindow(
        this.window,
        this.ctx.config.capturePolicy.consolePerWindow,
        diagnostics,
        "console records",
        this.ctx.config.capturePolicy.windowMs,
      )
    ) {
      return;
    }

    // The record builder sanitizes the arguments. A warn record keeps its Error among them.
    const used = method === "error" ? [textAt, errorAt] : [textAt];
    const rest = args.filter((_, index) => !used.includes(index));
    const attrs: Record<string, unknown> = { "console.method": method };

    if (rest.length > 0) {
      attrs["console.args"] = rest;
    }

    if (method === "warn") {
      logger.warn(message, attrs);
      return;
    }

    logger.error(message, error, { ...attrs, "error.captured_by": "console.error" });
  }
}
