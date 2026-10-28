// src/capture/console.ts
//
// Records the app's own console calls. Third-party code often reports a fault only to the console.

import { CONSOLE_BREADCRUMB_MAX_CHARS, ERROR_STORM_MAX_PER_WINDOW } from "../constants";
import type { CapturedConsoleMethod } from "../models/config";
import { type ErrorLike, isErrorLike } from "../utils/error-like";
import { isLibraryConsole, runAsLibraryConsole } from "../utils/library-console";
import { patch } from "../utils/patch";
import { truncate } from "../utils/sanitize";
import { allowInWindow, type StormWindow } from "./storm";
import type { Capture, CaptureContext } from "./types";

/** Methods that the capture accepts. */
const METHODS: readonly CapturedConsoleMethod[] = ["error", "warn", "info", "log"];

/** Methods that `capture.console: true` wraps. */
const DEFAULT_METHODS: readonly CapturedConsoleMethod[] = ["error", "warn"];

/** Signature of a console method. */
type ConsoleFn = (...args: unknown[]) => void;

/** Record function of a wrapper. Uninstall sets it to null. */
interface Target {
  /** Records one call, or null after uninstall. */
  record: ((args: unknown[]) => void) | null;
}

/** Target of a wrapper and the restore function of its patch. */
interface Wrapped {
  /** Target of the wrapper. */
  target: Target;
  /** Writes the original back if the method still holds the wrapper. Returns true then. */
  restore: () => boolean;
}

/**
 * Makes a wrapper that calls the original first, then the target.
 * The wrapper does not close over the capture. A wrapper that stays in place keeps no runtime.
 * @param original Method that was in place before the wrap.
 * @param target Target of the wrapper.
 * @returns The wrapper.
 */
function makeWrapper(original: ConsoleFn, target: Target): ConsoleFn {
  return (...args) => {
    // Call the original first. Devtools then shows the same text, also when a record fails.
    Reflect.apply(original, console, args);

    // Skip the lines that the library prints.
    if (isLibraryConsole()) {
      return;
    }

    target.record?.(args);
  };
}

/** Wraps the selected console methods. It records each call as a record or a breadcrumb. */
export class ConsoleCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "console";

  /** Active wrappers. A wrapper that is not in this map calls only the original. */
  private readonly wrapped = new Map<CapturedConsoleMethod, Wrapped>();

  /** Prevents a second wrap on a wrapped method. */
  private installed = false;

  /** Rate limit of this capture. Console noise must not use the allowance of the error capture. */
  private readonly window: StormWindow = { start: 0, count: 0 };

  /**
   * @param ctx Capture context containing configuration, diagnostics, logger, and breadcrumbs.
   */
  constructor(private readonly ctx: CaptureContext) {}

  /** Wraps each selected method. */
  install(): void {
    // Guard against a missing console. Some worker realms do not define it.
    if (this.installed || typeof console === "undefined") {
      return;
    }
    this.installed = true;

    for (const method of this.readMethods()) {
      this.wrap(method);
    }
  }

  /** Restores each method that still holds the wrapper of this capture. */
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

      // A restore here removes the wrapper of the other script. Leave it. The wrapper of this
      // capture then calls only the original.
      this.ctx.diagnostics.report(
        "capture.install_failed",
        `Another script wrapped console.${method} after the library. The library leaves that wrapper in place.`,
      );
    }

    this.wrapped.clear();
  }

  /**
   * Reads the methods from the configuration. It reports a value that is not usable.
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
        // The scope stops a console call in the record path from a second capture.
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

    // patch keeps the unbound method. Uninstall restores the same function, not a bound copy.
    const restore = patch(console, method, (original) => makeWrapper(original, target));
    this.wrapped.set(method, { target, restore });
  }

  /**
   * Records one console call.
   * @param method Console method of the call.
   * @param args Arguments of the call.
   */
  private record(method: CapturedConsoleMethod, args: unknown[]): void {
    // Duck typing finds an error from another realm. That error fails `instanceof Error`.
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

    if (!allowInWindow(this.window, ERROR_STORM_MAX_PER_WINDOW, diagnostics, "console records")) {
      return;
    }

    // The record builder sanitizes the arguments. A warn record keeps its Error in the arguments.
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
