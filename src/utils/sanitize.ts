// src/utils/sanitize.ts
//
// Sanitizes arbitrary data into JSON-safe structures with cycle detection and byte-size estimation.
// Never throws. Never returns a circular structure.

import {
  BYTES_PER_BOOLEAN,
  BYTES_PER_CONTAINER,
  BYTES_PER_KEY_OVERHEAD,
  BYTES_PER_NULL,
  BYTES_PER_NUMBER,
  BYTES_PER_QUOTED_STRING,
  HIGH_SURROGATE_MAX,
  HIGH_SURROGATE_MIN,
  MAX_NODE_CLASS_NAMES,
  UTF8_ONE_BYTE_CEILING,
  UTF8_TWO_BYTE_CEILING,
} from "../constants";

/** Structural depth and size limits enforced during object sanitization. */
export interface SanitizeLimits {
  /** Maximum recursion depth before truncating nested objects. */
  maxDepth: number;
  /** Maximum items retained in arrays, sets, and maps before truncating. */
  maxArrayLength: number;
  /** Maximum string attribute length in characters. */
  maxAttributeChars: number;
  /** Maximum key-value properties retained in a single object. */
  maxAttributeCount: number;
  /** Maximum error stack trace length in characters. */
  maxStackChars: number;
}

/**
 * Truncates a string to maximum character length while preserving UTF-16 surrogate pairs.
 * @param value Target string.
 * @param max Maximum allowed character length.
 * @returns Truncated string with appended drop count suffix.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  // Avoids splitting UTF-16 surrogate pairs at truncation boundaries. slice works in
  // code units. Half a pair serializes as U+FFFD.
  const end = isHighSurrogate(value.charCodeAt(max - 1)) ? max - 1 : max;
  return `${value.slice(0, end)}… [truncated ${String(value.length - end)} chars]`;
}

/**
 * Evaluates whether a UTF-16 code unit is a leading surrogate.
 * @param code UTF-16 character code.
 * @returns True if character is a high surrogate.
 */
function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

/** Structural interface for DOM Node inspection across realms. */
interface NodeLike {
  nodeName?: string;
  id?: string;
  className?: unknown;
}

/**
 * Formats a DOM node as a descriptive CSS selector string.
 * @param node Node-like object to format.
 * @returns Formatted selector string.
 */
function describeNode(node: NodeLike): string {
  const tag = (node.nodeName ?? "NODE").toLowerCase();
  const id = node.id ? `#${node.id}` : "";
  const cls =
    typeof node.className === "string" && node.className
      ? `.${node.className.trim().split(/\s+/).slice(0, MAX_NODE_CLASS_NAMES).join(".")}`
      : "";
  return `[Element ${tag}${id}${cls}]`;
}

/** Sanitized JSON-safe output with estimated serialized byte size. */
export interface SanitizeResult {
  /** JSON-safe sanitized structure. */
  value: unknown;
  /** Approximate serialized byte count. */
  bytes: number;
}

/** Mutable byte accumulator passed through recursive sanitization passes. */
interface SizeState {
  bytes: number;
}

/**
 * Sanitizes arbitrary values into JSON-safe structures without throwing.
 * @param value Raw value to sanitize.
 * @param limits Configuration limits for depth, count, and character lengths.
 * @returns JSON-safe sanitized value.
 */
export function sanitize(value: unknown, limits: SanitizeLimits): unknown {
  return sanitizeWithSize(value, limits).value;
}

/**
 * Sanitizes arbitrary values and calculates approximate serialized byte sizes.
 * @param value Raw value to sanitize.
 * @param limits Configuration limits.
 * @returns SanitizeResult containing sanitized value and byte count.
 */
export function sanitizeWithSize(value: unknown, limits: SanitizeLimits): SanitizeResult {
  const state: SizeState = { bytes: 0 };
  const result = walk(value, limits, new WeakSet(), 0, state);
  return { value: result, bytes: state.bytes };
}

/**
 * Adds string length and quotes overhead to size accumulator.
 * @param text Serialized string token.
 * @param state Byte size accumulator.
 * @returns Input text unchanged.
 */
function counted(text: string, state: SizeState): string {
  state.bytes += estimateBytes(text) + BYTES_PER_QUOTED_STRING;
  return text;
}

/**
 * Recursively walks object trees, replacing cyclic references, hostile getters, and invalid primitives.
 * @param value Target value to sanitize.
 * @param limits Truncation and depth limits.
 * @param seen Set of active ancestor objects for cycle detection.
 * @param depth Current recursion depth.
 * @param state Running byte size accumulator.
 * @returns JSON-safe sanitized representation.
 */
function walk(
  value: unknown,
  limits: SanitizeLimits,
  seen: WeakSet<object>,
  depth: number,
  state: SizeState,
): unknown {
  if (value === null || value === undefined) {
    state.bytes += BYTES_PER_NULL;
    return value;
  }

  if (typeof value === "string") {
    return counted(truncate(value, limits.maxAttributeChars), state);
  }
  if (typeof value === "number") {
    state.bytes += BYTES_PER_NUMBER;
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean") {
    state.bytes += BYTES_PER_BOOLEAN;
    return value;
  }
  if (typeof value === "bigint") {
    return counted(`${value.toString()}n`, state);
  }
  if (typeof value === "symbol") {
    return counted(value.toString(), state);
  }
  if (typeof value === "function") {
    return counted(`[Function ${value.name === "" ? "anonymous" : value.name}]`, state);
  }

  if (depth >= limits.maxDepth) {
    return counted("[MaxDepth]", state);
  }

  if (seen.has(value)) {
    return counted("[Circular]", state);
  }
  seen.add(value);
  state.bytes += BYTES_PER_CONTAINER;

  try {
    if (value instanceof Error) {
      return {
        name: counted(value.name, state),
        message: counted(truncate(value.message, limits.maxAttributeChars), state),
        stack: value.stack
          ? counted(truncate(value.stack, limits.maxStackChars), state)
          : undefined,
        cause: value.cause ? walk(value.cause, limits, seen, depth + 1, state) : undefined,
      };
    }
    if (value instanceof Date) {
      return counted(value.toISOString(), state);
    }
    if (value instanceof RegExp) {
      return counted(value.toString(), state);
    }
    if (value instanceof Map) {
      const map: ReadonlyMap<unknown, unknown> = value;
      const out: Record<string, unknown> = {};
      let shown = 0;
      for (const [key, entry] of map) {
        if (shown >= limits.maxArrayLength) {
          out["…"] = counted(`[${String(map.size - limits.maxArrayLength)} more entries]`, state);
          break;
        }
        shown++;
        const name = String(key);
        state.bytes += estimateBytes(name) + BYTES_PER_KEY_OVERHEAD;
        out[name] = walk(entry, limits, seen, depth + 1, state);
      }
      return out;
    }
    if (value instanceof Set) {
      const set: ReadonlySet<unknown> = value;
      return walk([...set].slice(0, limits.maxArrayLength), limits, seen, depth, state);
    }
    if (ArrayBuffer.isView(value)) {
      const length = (value as { length?: number }).length ?? 0;
      return counted(`[${value.constructor.name}(${String(length)})]`, state);
    }
    if (value instanceof Promise) {
      return counted("[Promise]", state);
    }
    if (typeof Node !== "undefined" && value instanceof Node) {
      return counted(describeNode(value), state);
    }

    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      const out: unknown[] = items
        .slice(0, limits.maxArrayLength)
        .map((item) => walk(item, limits, seen, depth + 1, state));
      if (items.length > limits.maxArrayLength) {
        out.push(counted(`[${String(items.length - limits.maxArrayLength)} more items]`, state));
      }
      return out;
    }

    const maybeToJson: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof maybeToJson === "function") {
      const toJson = maybeToJson as () => unknown;
      return walk(toJson.call(value), limits, seen, depth + 1, state);
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of keys) {
      if (count >= limits.maxAttributeCount) {
        out["…"] = counted(`[${String(keys.length - count)} more keys]`, state);
        break;
      }
      count++;
      state.bytes += estimateBytes(key) + BYTES_PER_KEY_OVERHEAD;
      out[key] = walk(record[key], limits, seen, depth + 1, state);
    }
    return out;
  } catch (error) {
    // Catches hostile getters and throwing proxies. One costs an attribute, not the
    // record.
    const name = error instanceof Error ? error.name : "error";
    return counted(`[Unserializable: ${name}]`, state);
  } finally {
    // Removes object from ancestor set on unwind. Left in, a repeated sibling reads
    // as a cycle.
    seen.delete(value);
  }
}

/**
 * Estimates UTF-8 encoded byte length for a string.
 * @param value Target string.
 * @returns Estimated UTF-8 byte length.
 */
export function estimateBytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < UTF8_ONE_BYTE_CEILING) {
      bytes += 1;
    } else if (code < UTF8_TWO_BYTE_CEILING) {
      bytes += 2;
    } else if (code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
