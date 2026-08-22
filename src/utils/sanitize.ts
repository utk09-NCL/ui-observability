// src/utils/sanitize.ts
//
// This module is why one bad payload cannot take down a batch of a hundred
// unrelated records. Sanitizing happens when a record is built rather than when
// a batch is sent, so a circular object poisons the single record that carried
// it instead of the whole request.
//
// The size accounting rides along on the same walk because it is free here and
// expensive anywhere else. The obvious alternative, stringifying the finished
// attributes and measuring the string, serializes every record twice: once to
// measure and once to send. On a screen logging a few hundred records a second
// that is the most expensive line in the library, and it does nothing but
// arithmetic.

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

/**
 * The subset of the configured limits this module enforces, so a caller need not pass the whole
 * config.
 */
export interface SanitizeLimits {
  /** How far down to walk before returning a marker instead of recursing. */
  maxDepth: number;
  /** How many items of an array, set or map to keep. The rest become a count. */
  maxArrayLength: number;
  /** Longest a single string attribute may be. */
  maxAttributeChars: number;
  /** How many keys of one object to keep. The rest become a count. */
  maxAttributeCount: number;
  /**
   * Longest a stack trace may be. Separate from `maxAttributeChars`, since a useful stack is longer
   * than a useful string.
   */
  maxStackChars: number;
}

/**
 * Shorten a string to `max` characters, saying how much was dropped. Safe to hand any string,
 * including one holding emoji.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  // Never cut a surrogate pair in half. `slice` works in UTF-16 code units, so
  // the obvious version can leave a lone surrogate behind, which is not a
  // character and which some ingest pipelines reject outright.
  const end = isHighSurrogate(value.charCodeAt(max - 1)) ? max - 1 : max;
  return `${value.slice(0, end)}… [truncated ${String(value.length - end)} chars]`;
}

/**
 * Whether a UTF-16 code unit is the leading half of a surrogate pair, and therefore must not be the
 * last one kept.
 */
function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

/**
 * Structural rather than `Node`, so a node from another realm or behind a proxy
 * still describes rather than throwing. Nothing here assumes a property exists.
 */
interface NodeLike {
  nodeName?: string;
  id?: string;
  className?: unknown;
}

/**
 * A DOM node as a short CSS-like selector, which is what someone reading the log actually wants.
 * Never serialize the node itself.
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

/** A sanitized value and what it is expected to cost on the wire. */
export interface SanitizeResult {
  /** The JSON-safe value. Guaranteed to survive `JSON.stringify` without throwing. */
  value: unknown;
  /**
   * Roughly how many bytes the result will serialize to.
   *
   * Approximate on purpose. It lets the record builder enforce a size budget
   * without stringifying every record just to measure it. Strings are counted
   * exactly and everything else gets a small fixed estimate.
   */
  bytes: number;
}

/**
 * The running byte total, carried through the walk by reference so a recursive call can add to it.
 */
interface SizeState {
  bytes: number;
}

/**
 * Convert an arbitrary value into something `JSON.stringify` can always handle.
 * Never throws. Never returns a circular structure.
 */
export function sanitize(value: unknown, limits: SanitizeLimits): unknown {
  return sanitizeWithSize(value, limits).value;
}

/** As `sanitize`, and also reports the approximate size of what came back. */
export function sanitizeWithSize(value: unknown, limits: SanitizeLimits): SanitizeResult {
  const state: SizeState = { bytes: 0 };
  const result = walk(value, limits, new WeakSet(), 0, state);
  return { value: result, bytes: state.bytes };
}

/** Count a value that is already in its final form, and hand it back. */
function counted(text: string, state: SizeState): string {
  state.bytes += estimateBytes(text) + BYTES_PER_QUOTED_STRING;
  return text;
}

/**
 * The recursive worker: one value in, one JSON-safe value out, with its size
 * added to `state` on the way.
 *
 * `seen` holds the current ancestor chain rather than everything visited, which
 * is what makes a genuine cycle a `[Circular]` marker while the same object
 * appearing twice as a sibling is serialized twice, as it should be.
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

  // Narrowed with `typeof` rather than read into a variable and asserted back.
  // Storing `typeof value` first defeats control flow narrowing, and every
  // branch then needs a cast that the compiler cannot check.
  if (typeof value === "string") {
    return counted(truncate(value, limits.maxAttributeChars), state);
  }
  if (typeof value === "number") {
    state.bytes += BYTES_PER_NUMBER;
    // NaN and the infinities are not representable in JSON.
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
        stack: value.stack ? counted(truncate(value.stack, limits.maxStackChars), state) : undefined,
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
      // Narrowing an `unknown` with `instanceof` yields `Map<any, any>`, and
      // reading `any` back out is exactly what the unsafe rules exist to stop.
      // Widening to `unknown` keys and values costs nothing and restores them.
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
      // Same depth, not deeper: the array is this module's own representation
      // of the set, not another level the consumer wrote.
      return walk([...set].slice(0, limits.maxArrayLength), limits, seen, depth, state);
    }
    if (ArrayBuffer.isView(value)) {
      // `ArrayBufferView` covers `DataView` too, which has no `length`.
      const length = (value as { length?: number }).length ?? 0;
      return counted(`[${value.constructor.name}(${String(length)})]`, state);
    }
    // No `typeof Promise !== "undefined"` guard, unlike `Node` below. Promise
    // is ES2015 and exists in every runtime this library targets, workers
    // included, so the guard could never take its false branch. And if some
    // exotic host really lacked it, `instanceof undefined` throws a TypeError
    // that the catch below already turns into an unserializable marker.
    if (value instanceof Promise) {
      return counted("[Promise]", state);
    }
    // `Node` does not exist in a worker, so it is checked rather than assumed.
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

    // Respect an explicit toJSON, which is how most library objects want to be
    // serialized.
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
    // A getter threw, or a proxy refused. Never let that escape: the whole
    // point of this module is that one hostile value costs one attribute.
    const name = error instanceof Error ? error.name : "error";
    return counted(`[Unserializable: ${name}]`, state);
  } finally {
    // Dropping it on the way back up is what makes only genuine ancestor cycles
    // count. Without this, the same object appearing twice as siblings would be
    // reported as circular, which is wrong.
    seen.delete(value);
  }
}

/** Cheap UTF-8 byte estimate. Avoids allocating a Blob per record. */
export function estimateBytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < UTF8_ONE_BYTE_CEILING) {
      bytes += 1;
    } else if (code < UTF8_TWO_BYTE_CEILING) {
      bytes += 2;
    } else if (code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX) {
      // A surrogate pair is four bytes in UTF-8, and its low half must not be
      // counted again on the next iteration.
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
