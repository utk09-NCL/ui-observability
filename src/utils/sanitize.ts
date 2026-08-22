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

export interface SanitizeLimits {
  maxDepth: number;
  maxArrayLength: number;
  maxAttributeChars: number;
  maxAttributeCount: number;
  maxStackChars: number;
}

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

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
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

function describeNode(node: NodeLike): string {
  const tag = (node.nodeName ?? "NODE").toLowerCase();
  const id = node.id ? `#${node.id}` : "";
  const cls =
    typeof node.className === "string" && node.className
      ? `.${node.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
  return `[Element ${tag}${id}${cls}]`;
}

export interface SanitizeResult {
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
  state.bytes += estimateBytes(text) + 2;
  return text;
}

function walk(
  value: unknown,
  limits: SanitizeLimits,
  seen: WeakSet<object>,
  depth: number,
  state: SizeState,
): unknown {
  if (value === null || value === undefined) {
    state.bytes += 4;
    return value;
  }

  // Narrowed with `typeof` rather than read into a variable and asserted back.
  // Storing `typeof value` first defeats control flow narrowing, and every
  // branch then needs a cast that the compiler cannot check.
  if (typeof value === "string") {
    return counted(truncate(value, limits.maxAttributeChars), state);
  }
  if (typeof value === "number") {
    state.bytes += 8;
    // NaN and the infinities are not representable in JSON.
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean") {
    state.bytes += 5;
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
  state.bytes += 2;

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
        state.bytes += estimateBytes(name) + 4;
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
      state.bytes += estimateBytes(key) + 4;
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
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
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
