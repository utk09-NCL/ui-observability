// src/bus/validation.ts
//
// Checks the required fields and values of messages from another context.

import type { BusMessage } from "../models/bus";
import type { FlushResult } from "../models/health";
import { isLogLevel, isLogRecord } from "../models/log-record";
import { BUS_TYPE, SEVERITY_NUMBER } from "../constants";
import { isObject } from "../utils/guards";

/** The statuses a flush result can have. */
const FLUSH_STATUSES: readonly unknown[] = ["complete", "timeout", "inactive"];

/**
 * Checks the fields that each bus message type requires. unwrap() only checks the envelope.
 * @param value Message to check.
 * @returns True if the message has the required fields and values.
 */
export function validMessage(value: unknown): value is BusMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.from !== "string" || !m.from || typeof m.t !== "string") return false;
  const text = (key: string): boolean => typeof m[key] === "string";
  switch (m.t) {
    case BUS_TYPE.hello:
    case BUS_TYPE.tab:
      return text("tabId");
    case BUS_TYPE.welcome:
      return (
        text("to") &&
        text("tabId") &&
        (m.routingContextId === undefined || text("routingContextId"))
      );
    case BUS_TYPE.journeyRequest:
    case BUS_TYPE.samplingRequest:
      return true;
    case BUS_TYPE.securityContext:
      return text("id") && m.id !== "";
    case BUS_TYPE.journey:
      return (m.to === undefined || text("to")) && "journey" in m;
    case BUS_TYPE.sampling:
      return text("to") && "rules" in m;
    case BUS_TYPE.flushRequest:
      return text("id") && typeof m.timeoutMs === "number";
    case BUS_TYPE.flushResult:
      return text("id") && "result" in m;
    case BUS_TYPE.records:
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

/**
 * Copies a flush result from another context and checks the copy. Each field is read once, so
 * a getter can't pass the check with one value and hand over another.
 * @param value The answer's result.
 * @returns The copy, or null when the status is unknown or a count isn't a safe integer of 0
 * or more.
 */
export function readFlushResult(value: unknown): FlushResult | null {
  if (!isObject(value)) {
    return null;
  }

  const { status, accepted, stored, dropped, forwarded, pending } = value;
  const counts = [accepted, stored, dropped, forwarded, pending];
  const whole = counts.every((count) => Number.isSafeInteger(count) && (count as number) >= 0);
  // "complete" means that no record waits, so a count of pending records contradicts it.
  if (!whole || !FLUSH_STATUSES.includes(status) || (status === "complete" && pending !== 0)) {
    return null;
  }

  return { status, accepted, stored, dropped, forwarded, pending } as FlushResult;
}
