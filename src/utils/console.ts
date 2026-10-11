// src/utils/console.ts
//
// Formats and mirrors log records to the developer console during local execution

import { CONSOLE_PREFIX_STYLE, LEVEL_ORDER, RECORD_LIMITS } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
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
   * @param minLevel Minimum log level required to emit, or null to mirror nothing.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private minLevel: LogLevel | null,
    private diagnostics: Diagnostics,
  ) {}

  /**
   * Updates the console mirroring threshold.
   * @param minLevel Minimum log level required to emit, or null to mirror nothing.
   */
  update(minLevel: LogLevel | null): void {
    this.minLevel = minLevel;
  }

  /**
   * Tests whether a level clears the console threshold.
   * @param level Severity level of the record.
   * @returns True if the sink prints this level.
   */
  accepts(level: LogLevel): boolean {
    return this.minLevel !== null && LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
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
    // Prevents throws in environments where console is undefined. Absent in a worker
    // realm stripped of it.
    if (typeof console === "undefined") {
      return;
    }

    // The namespace goes in as a %s argument. A %o or %c in it then prints as text.
    const prefix = `%c[%s]%c ${level}`;
    const method = METHOD[level];

    // A host can replace console with instrumented methods that throw. Unguarded,
    // the mirror takes down the caller's log call.
    this.diagnostics.guard("handler.threw", `mirroring to console.${method}`, () => {
      const details: unknown[] = [];

      if (error !== undefined) {
        details.push(error);
      }

      // Devtools keeps a reference to each logged object. A copy releases the caller's object.
      if (payload !== undefined) {
        details.push(sanitize(payload, RECORD_LIMITS));
      }

      console[method](prefix, CONSOLE_PREFIX_STYLE, namespace, "", message, ...details);
    });
  }
}
