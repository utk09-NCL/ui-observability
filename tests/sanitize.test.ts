// tests/sanitize.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  estimateBytes,
  type SanitizeLimits,
  sanitize,
  sanitizeWithSize,
  truncate,
} from "../src/utils/sanitize";

const limits: SanitizeLimits = {
  maxDepth: 4,
  maxArrayLength: 3,
  maxAttributeChars: 20,
  maxAttributeCount: 3,
  maxStackChars: 100,
};

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

describe("truncate", () => {
  it("returns a string that is already within the limit untouched", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("ab", 3)).toBe("ab");
  });

  it("annotates how much was removed", () => {
    expect(truncate("abcdef", 3)).toBe("abc… [truncated 3 chars]");
  });

  it("never cuts a surrogate pair in half", () => {
    // "ab😀cd": the emoji occupies code units 2 and 3, so cutting at 3 would
    // leave a lone high surrogate, which is not a character.
    const cut = truncate("ab😀cd", 3);

    expect(cut).toBe("ab… [truncated 4 chars]");
    expect(cut.codePointAt(1)).toBe("b".codePointAt(0));
  });
});

describe("estimateBytes", () => {
  it("counts one, two, three and four byte characters", () => {
    expect(estimateBytes("abc")).toBe(3);
    expect(estimateBytes("é")).toBe(2);
    expect(estimateBytes("€")).toBe(3);
    expect(estimateBytes("😀")).toBe(4);
  });

  it("does not count the low half of a surrogate pair twice", () => {
    expect(estimateBytes("😀😀")).toBe(8);
    expect(estimateBytes("a😀b")).toBe(6);
  });

  it("is zero for an empty string", () => {
    expect(estimateBytes("")).toBe(0);
  });
});

describe("sanitize primitives", () => {
  it("passes null and undefined straight through", () => {
    expect(sanitize(null, limits)).toBeNull();
    expect(sanitize(undefined, limits)).toBeUndefined();
  });

  it("truncates a long string to the attribute limit", () => {
    const out = sanitize("x".repeat(30), limits);

    expect(out).toBe(`${"x".repeat(20)}… [truncated 10 chars]`);
  });

  it("keeps a finite number as a number and stringifies the ones JSON cannot hold", () => {
    expect(sanitize(42, limits)).toBe(42);
    expect(sanitize(Number.NaN, limits)).toBe("NaN");
    expect(sanitize(Number.POSITIVE_INFINITY, limits)).toBe("Infinity");
  });

  it("keeps booleans", () => {
    expect(sanitize(true, limits)).toBe(true);
    expect(sanitize(false, limits)).toBe(false);
  });

  it("marks a bigint so it is not confused with a number", () => {
    expect(sanitize(10n, limits)).toBe("10n");
  });

  it("describes a symbol", () => {
    expect(sanitize(Symbol("trade"), limits)).toBe("Symbol(trade)");
  });

  it("names a function, and says anonymous when it has no name", () => {
    function named(): void {
      // deliberately empty
    }
    // Created inside an array literal so it gets no inferred name.
    const anonymous = [() => undefined][0];

    expect(sanitize(named, limits)).toBe("[Function named]");
    expect(sanitize(anonymous, limits)).toBe("[Function anonymous]");
  });
});

describe("sanitize structures", () => {
  it("replaces a genuine cycle but keeps repeated siblings intact", () => {
    const shared = { id: 1 };
    const root: Record<string, unknown> = { a: shared, b: shared };
    root.self = root;

    const out = asRecord(sanitize(root, limits));

    expect(out.a).toEqual({ id: 1 });
    // Not "[Circular]": a sibling is not an ancestor.
    expect(out.b).toEqual({ id: 1 });
    expect(out.self).toBe("[Circular]");
  });

  it("stops at the depth limit", () => {
    const deep = { a: { b: { c: { d: { e: "too far" } } } } };

    const out = asRecord(sanitize(deep, limits));
    const a = asRecord(out.a);
    const b = asRecord(a.b);
    const c = asRecord(b.c);

    expect(c.d).toBe("[MaxDepth]");
  });

  it("caps an array and says how many were dropped", () => {
    expect(sanitize([1, 2, 3, 4, 5], limits)).toEqual([1, 2, 3, "[2 more items]"]);
  });

  it("leaves a short array alone", () => {
    expect(sanitize([1, 2], limits)).toEqual([1, 2]);
  });

  it("caps object keys and says how many were dropped", () => {
    const out = asRecord(sanitize({ a: 1, b: 2, c: 3, d: 4, e: 5 }, limits));

    expect(out).toEqual({ a: 1, b: 2, c: 3, "…": "[2 more keys]" });
  });

  it("leaves a small object alone", () => {
    expect(sanitize({ a: 1 }, limits)).toEqual({ a: 1 });
  });

  it("converts a Map to an object, capping it", () => {
    const small = new Map<string, number>([["a", 1]]);
    const big = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
      ["e", 5],
    ]);

    expect(sanitize(small, limits)).toEqual({ a: 1 });
    expect(sanitize(big, limits)).toEqual({
      a: 1,
      b: 2,
      c: 3,
      "…": "[2 more entries]",
    });
  });

  it("stringifies non-string Map keys", () => {
    expect(sanitize(new Map<number, string>([[1, "one"]]), limits)).toEqual({ "1": "one" });
  });

  it("converts a Set to a capped array", () => {
    expect(sanitize(new Set([1, 2]), limits)).toEqual([1, 2]);
    expect(sanitize(new Set([1, 2, 3, 4, 5]), limits)).toEqual([1, 2, 3]);
  });

  it("formats a Date as an ISO string and a RegExp as its source", () => {
    expect(sanitize(new Date("2026-08-22T00:00:00.000Z"), limits)).toBe("2026-08-22T00:00:00.000Z");
    expect(sanitize(/ab+c/gi, limits)).toBe("/ab+c/gi");
  });

  it("summarises binary views, including one with no length", () => {
    expect(sanitize(new Uint8Array([1, 2, 3]), limits)).toBe("[Uint8Array(3)]");
    // DataView is an ArrayBufferView with no length property at all.
    expect(sanitize(new DataView(new ArrayBuffer(8)), limits)).toBe("[DataView(0)]");
  });

  it("does not try to inspect a promise", () => {
    expect(sanitize(Promise.resolve(1), limits)).toBe("[Promise]");
  });

  it("prefers an explicit toJSON", () => {
    const custom = {
      id: 7,
      toJSON: () => ({ shape: "custom" }),
    };

    expect(sanitize(custom, limits)).toEqual({ shape: "custom" });
  });
});

describe("sanitize errors", () => {
  it("flattens an Error including its cause and truncates the stack", () => {
    const err = new Error("outer", { cause: new Error("inner") });

    const out = asRecord(sanitize(err, limits));

    expect(out.name).toBe("Error");
    expect(out.message).toBe("outer");
    expect(asRecord(out.cause).message).toBe("inner");
    expect(typeof out.stack).toBe("string");
  });

  it("handles an Error with no stack and no cause", () => {
    const err = new Error("bare");
    err.stack = undefined;

    const out = asRecord(sanitize(err, limits));

    expect(out.stack).toBeUndefined();
    expect(out.cause).toBeUndefined();
    expect(out.message).toBe("bare");
  });

  it("never throws when a getter throws, and names the error type", () => {
    const hostile = {
      get boom(): never {
        throw new TypeError("nope");
      },
    };

    expect(() => sanitize({ hostile }, limits)).not.toThrow();
    expect(asRecord(sanitize({ hostile }, limits)).hostile).toBe("[Unserializable: TypeError]");
  });

  it("survives a getter that throws something which is not an Error", () => {
    const hostile = {
      get boom(): never {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately not an Error, to reach the non-Error path of the sanitizer's own catch
        throw "a bare string";
      },
    };

    expect(asRecord(sanitize({ hostile }, limits)).hostile).toBe("[Unserializable: error]");
  });
});

describe("sanitize DOM nodes", () => {
  it("describes an element by tag, id and the first few classes", () => {
    const el = document.createElement("div");
    el.id = "grid";
    el.className = "a b c d";

    expect(sanitize(el, limits)).toBe("[Element div#grid.a.b.c]");
  });

  it("omits the id and classes when the element has neither", () => {
    expect(sanitize(document.createElement("span"), limits)).toBe("[Element span]");
  });

  it("copes with a node whose className is not a string", () => {
    // A text node has no className at all, which is the same branch a
    // non-string className takes.
    expect(sanitize(document.createTextNode("hello"), limits)).toBe("[Element #text]");
  });

  it("falls back to NODE when a node-like object has no nodeName", () => {
    // A node from another realm, or behind a proxy, can satisfy instanceof
    // without carrying the properties the DOM says it has.
    // A plain object is enough: `instanceof` looks up Symbol.hasInstance on
    // whatever is on its right, so this needs no class to stand in for Node.
    const foreignNode = { [Symbol.hasInstance]: () => true };
    vi.stubGlobal("Node", foreignNode);

    expect(sanitize({}, limits)).toBe("[Element node]");
  });

  it("does not reach for Node in a context that has none", () => {
    vi.stubGlobal("Node", undefined);

    // Reaching the plain-object branch at all proves the guard short-circuited
    // rather than throwing on `instanceof undefined`.
    expect(sanitize({ a: 1 }, limits)).toEqual({ a: 1 });
  });
});

describe("sanitizeWithSize", () => {
  it("grows with the payload, so the record builder never has to stringify to measure", () => {
    const small = sanitizeWithSize({ a: "x" }, limits).bytes;
    const large = sanitizeWithSize({ a: "x".repeat(19) }, limits).bytes;

    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });

  it("returns the sanitized value alongside the size", () => {
    const result = sanitizeWithSize({ a: 1 }, limits);

    expect(result.value).toEqual({ a: 1 });
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("counts something for every primitive kind", () => {
    expect(sanitizeWithSize(null, limits).bytes).toBe(4);
    expect(sanitizeWithSize(1, limits).bytes).toBe(8);
    expect(sanitizeWithSize(true, limits).bytes).toBe(5);
  });
});
