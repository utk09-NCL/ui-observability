// src/utils/console.ts
//
// Formats and mirrors log records to the developer console during local execution

import { LEVEL_ORDER, RECORD_LIMITS } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { ResolvedConsole } from "../models/config";
import type { LogLevel } from "../models/log-record";
import { sanitize } from "./sanitize";

/** Maps log levels to corresponding console method names. */
const METHOD: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  TRACE: "debug",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  FATAL: "error",
};

/** Mirrors log records directly to browser or Node console methods based on severity. */
export class ConsoleSink {
  /**
   * @param settings Console level and styles. A null level prints nothing.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private settings: ResolvedConsole,
    private diagnostics: Diagnostics,
  ) {}

  /**
   * Replaces the console level and styles.
   * @param settings Console level and styles. A null level prints nothing.
   */
  update(settings: ResolvedConsole): void {
    this.settings = settings;
  }

  /**
   * Tests whether a level clears the console threshold.
   * @param level Severity level of the record.
   * @returns True if the sink prints this level.
   */
  accepts(level: LogLevel): boolean {
    return this.settings.level !== null && LEVEL_ORDER[level] >= LEVEL_ORDER[this.settings.level];
  }

  /**
   * Prints a styled log line if the level clears the console threshold.
   * @param namespace Logger namespace, shown in the prefix.
   * @param level Severity level of the record.
   * @param message Primary log message.
   * @param payload Caller payload. The sink prints a sanitized copy.
   * @param error Error to print before the payload.
   */
  write(
    namespace: string,
    level: LogLevel,
    message: string,
    payload?: Record<string, unknown>,
    error?: Error,
  ): void {
    if (!this.accepts(level)) {
      return;
    }
    // Guard against a missing console. Some worker realms do not define it.
    if (typeof console === "undefined") {
      return;
    }

    // Pass the namespace as a %s argument. Then a %o or %c in the namespace prints as text.
    // The last %c resets the style. The message then prints in the default style.
    const prefix = `%c[%s]%c[${level}]%c`;
    const { styles } = this.settings;
    const method = METHOD[level];

    // A host can replace console methods with methods that throw. The guard stops that
    // error from breaking the log call of the caller.
    this.diagnostics.guard(
      "handler.threw",
      `The library could not print to console.${method}.`,
      () => {
        const details: unknown[] = [];

        if (error !== undefined) {
          details.push(error);
        }

        // Devtools keeps a reference to each logged object. A copy releases the caller's object.
        if (payload !== undefined) {
          details.push(sanitize(payload, RECORD_LIMITS, this.diagnostics));
        }

        console[method](
          prefix,
          styles.namespace,
          namespace,
          styles[level],
          "",
          message,
          ...details,
        );
      },
    );
  }
}
