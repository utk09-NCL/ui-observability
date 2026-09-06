// src/utils/console.ts
//
// Formats and mirrors log records to the developer console during local execution

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

/** Mirrors log records directly to browser or Node console methods based on severity. */
export class ConsoleSink {
  /**
   * @param minLevel Minimum log level required to emit, or null to mirror nothing.
   */
  constructor(private minLevel: LogLevel | null) {}

  /**
   * Updates the console mirroring threshold.
   * @param minLevel Minimum log level required to emit, or null to mirror nothing.
   */
  update(minLevel: LogLevel | null): void {
    this.minLevel = minLevel;
  }

  /**
   * Emits a styled log record to the console if severity clears the configured threshold.
   * @param level Severity level of the record.
   * @param message Primary log message.
   * @param payload Optional contextual payload or object reference.
   */
  write(level: LogLevel, message: string, payload?: unknown): void {
    if (this.minLevel === null || LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    // Prevents throws in environments where console is undefined. Absent in a worker
    // realm stripped of it.
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
