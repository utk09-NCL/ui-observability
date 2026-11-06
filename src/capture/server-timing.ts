import { SERVER_TIMING_MAX_CHARS, SERVER_TIMING_MAX_ENTRIES } from "../constants";

/** One duration entry from the Server-Timing response header. */
interface ServerTimingEntry {
  name: string;
  duration: number;
  description: string;
}

/** Server duration entries and the server span that they name. */
export interface ServerTiming {
  entries: ServerTimingEntry[];
  link?: { traceId: string; spanId: string };
}

/** Splits a header outside quoted strings. Escaped quotes do not end a string. */
function splitHeader(text: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
    } else if (quoted && char === "\\") {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

/** Finds the header in an XHR header list. Chrome prints an error for a direct hidden read. */
export function xhrServerTiming(headers: string): string | null {
  return /^server-timing:(.*)$/im.exec(headers)?.[1] ?? null;
}

/** Reads bounded server duration entries. A missing header gives no entries. */
export function readServerTiming(header: string | null): ServerTiming {
  const result: ServerTiming = { entries: [] };
  if (!header) {
    return result;
  }

  for (const part of splitHeader(header.slice(0, SERVER_TIMING_MAX_CHARS), ",").slice(
    0,
    SERVER_TIMING_MAX_ENTRIES,
  )) {
    const [rawName, ...params] = splitHeader(part, ";");
    const name = rawName.trim();
    if (!/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name)) {
      continue;
    }

    const entry: ServerTimingEntry = { name, duration: 0, description: "" };
    const seen = new Set<string>();
    for (const param of params) {
      const equal = param.indexOf("=");
      if (equal < 0) {
        continue;
      }

      const key = param.slice(0, equal).trim().toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      let value = param.slice(equal + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/\\(.)/g, "$1");
      }

      if (key === "dur") {
        const duration = Number(value);
        if (Number.isFinite(duration) && duration >= 0) {
          entry.duration = duration;
        }
      } else if (key === "desc") {
        entry.description = value;
      }
    }

    result.entries.push(entry);
    if (name.toLowerCase() === "traceparent") {
      const match = /^00-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec(entry.description);
      if (match && /[1-9a-f]/.test(match[1]) && /[1-9a-f]/.test(match[2])) {
        result.link = { traceId: match[1], spanId: match[2] };
      }
    }
  }

  return result;
}
