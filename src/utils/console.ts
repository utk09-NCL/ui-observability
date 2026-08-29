// src/utils/console.ts
//
// Formats and mirrors log records to the developer console during local execution.

import { CONSOLE_PREFIX_STYLE, LEVEL_ORDER, LIBRARY_LOG_PREFIX } from "../constants";
import type { LogLevel } from "../models/log-record";

/** Maps log levels to corresponding console method names. */
const METHOD: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  TRACE: "debug",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  FATAL: "error",
};

/**
 * Mirrors log records directly to browser or Node console methods based on
 * severity, at its own level, independent of the pipeline's `minLevel`.
 */
export class ConsoleSink {
  /**
   * @param enabled Indicates whether console mirroring is active.
   * @param minLevel Minimum log level required to emit to the console.
   */
  constructor(
    private enabled: boolean,
    private minLevel: LogLevel,
  ) {}

  /**
   * Updates console sink configuration settings.
   * @param enabled Indicates whether console mirroring is active.
   * @param minLevel Minimum log level required to emit to the console.
   */
  update(enabled: boolean, minLevel: LogLevel): void {
    this.enabled = enabled;
    this.minLevel = minLevel;
  }

  /**
   * Emits a styled log record to the console if severity clears the configured threshold.
   * @param level Severity level of the record.
   * @param message Primary log message.
   * @param payload Optional contextual payload or object reference.
   */
  write(level: LogLevel, message: string, payload?: unknown): void {
    // Checked here, on the write path. Checking only at setup means
    // `console: { enabled: false }` still prints everything, which is a console
    // flood and a retained-object leak in production.
    if (!this.enabled) {
      return;
    }
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    // Absent in a worker realm stripped of it, where a call would throw.
    if (typeof console === "undefined") {
      return;
    }

    const prefix = `%c${LIBRARY_LOG_PREFIX}%c ${level}`;
    if (payload === undefined) {
      console[METHOD[level]](prefix, CONSOLE_PREFIX_STYLE, "", message);
      return;
    }

    console[METHOD[level]](prefix, CONSOLE_PREFIX_STYLE, "", message, payload);
  }
}
