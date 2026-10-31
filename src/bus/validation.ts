// src/bus/validation.ts
//
// Checks the required fields and values of messages from another context.

import type { BusMessage } from "../models/bus";
import { isLogLevel, isLogRecord } from "../models/log-record";
import { SEVERITY_NUMBER } from "../constants";

/**
 * Checks the fields required by each bus message type. unwrap() checks the envelope only.
 * @param value Message to check.
 * @returns True if the message has the required fields and values.
 */
export function validMessage(value: unknown): value is BusMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.from !== "string" || !m.from || typeof m.t !== "string") return false;
  const text = (key: string): boolean => typeof m[key] === "string";
  switch (m.t) {
    case "hello":
    case "tab":
      return text("tabId");
    case "welcome":
      return (
        text("to") &&
        text("tabId") &&
        (m.routingContextId === undefined || text("routingContextId"))
      );
    case "journey?":
    case "sampling?":
      return true;
    case "security-context":
      return text("id") && m.id !== "";
    case "journey":
      return (m.to === undefined || text("to")) && "journey" in m;
    case "sampling":
      return text("to") && "rules" in m;
    case "records":
      return (
        Array.isArray(m.records) &&
        (m.routingContextId === undefined || text("routingContextId")) &&
        m.records.every((r: unknown) => {
          if (!isLogRecord(r) || !isLogLevel(r.severityText)) return false;
          return (
            !Array.isArray(r.attributes) &&
            !Array.isArray(r.resource) &&
            /^\d+$/.test(r.timeUnixNano) &&
            (r.observedTimeUnixNano === undefined || /^\d+$/.test(r.observedTimeUnixNano)) &&
            typeof r.traceId === "string" &&
            /^(?:[a-f\d]{32})?$/.test(r.traceId) &&
            typeof r.spanId === "string" &&
            /^(?:[a-f\d]{16})?$/.test(r.spanId) &&
            Number.isInteger(r.traceFlags) &&
            r.traceFlags >= 0 &&
            r.traceFlags <= 255 &&
            r.severityNumber === SEVERITY_NUMBER[r.severityText]
          );
        })
      );
    default:
      return false;
  }
}
