// src/observability-settings/tap.ts
//
// A processor that counts the records and keeps the last 50 of each kind, and a diagnostic
// handler that keeps the last 20 reports. The panel reads both. Neither one changes a record.
//
// A processor sees each record that the library builds. That is more than the records that go
// out, because the library also builds a record for the console, or for a breadcrumb when
// sampling drops it. So the count is "records built", not "records sent".

import type { DiagnosticEvent, LogRecord } from "@utk09/ui-observability";

const RECENT_LIMIT = 50;

// These namespaces write many records a second. They have their own list of 50, so a stream of
// price ticks can't push an ORDER_PLACED or an error record out of the list of the other records.
const NOISY_NAMESPACES = new Set(["market.prices", "observability.meter"]);
const DIAGNOSTIC_LIMIT = 20;
const BODY_CHARS = 200;

export interface TappedRecord {
  id: number;
  at: number;
  level: string;
  namespace: string;
  type: string;
  body: string;
}

export interface TappedDiagnostic {
  id: number;
  code: string;
  message: string;
}

let built = 0;
let recent: TappedRecord[] = [];
let recentNoisy: TappedRecord[] = [];
let reported = 0;
let diagnostics: TappedDiagnostic[] = [];

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Counts one record and keeps a short summary of it. It runs inside every log call, so it only
 * reads four fields.
 * @param record The record the library built.
 * @returns The same record.
 */
export function tapProcessor(record: LogRecord): LogRecord {
  built += 1;
  const namespace = textOf(record.attributes["app.namespace"]);
  const noisy = NOISY_NAMESPACES.has(namespace);
  const list = noisy ? recentNoisy : recent;
  list.push({
    id: built,
    at: Date.now(),
    level: record.severityText,
    namespace,
    type: textOf(record.attributes["log.type"]),
    body: record.body.slice(0, BODY_CHARS),
  });
  if (list.length > RECENT_LIMIT) {
    list.shift();
  }

  return record;
}

/** Keeps the report of a diagnostic. The library throttles each code to one report a second. */
export function tapDiagnostic(event: DiagnosticEvent): void {
  reported += 1;
  diagnostics.push({ id: reported, code: event.code, message: event.message });
  if (diagnostics.length > DIAGNOSTIC_LIMIT) {
    diagnostics.shift();
  }
}

/** Returns how many records the processors saw, and the last ones, oldest first. */
export function readTap(): { built: number; recent: readonly TappedRecord[] } {
  return { built, recent: [...recent, ...recentNoisy].sort((a, b) => a.id - b.id) };
}

/** Returns the last diagnostic reports. */
export function readDiagnostics(): readonly TappedDiagnostic[] {
  return [...diagnostics];
}

/** Empties the tap. Tests use it, so one spec doesn't see the records of another. */
export function resetTap(): void {
  built = 0;
  recent = [];
  recentNoisy = [];
  reported = 0;
  diagnostics = [];
}
