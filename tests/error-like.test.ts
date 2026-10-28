import { describe, expect, it } from "vitest";
import { isErrorLike } from "../src/utils/error-like";

describe("isErrorLike", () => {
  it("accepts an Error and an error from another realm", () => {
    const foreign = { name: "TypeError", message: "x is undefined", stack: "TypeError: x" };

    expect(isErrorLike(new RangeError("out of range"))).toBe(true);
    expect(isErrorLike(foreign)).toBe(true);
    expect(isErrorLike({ name: "Error", message: "no stack" })).toBe(true);
  });

  it("rejects a value without a string name, a string message and a string stack", () => {
    expect(isErrorLike("text")).toBe(false);
    expect(isErrorLike(null)).toBe(false);
    expect(isErrorLike({ name: 1, message: "m" })).toBe(false);
    expect(isErrorLike({ name: "Error", message: 1 })).toBe(false);
    expect(isErrorLike({ name: "Error", message: "m", stack: 1 })).toBe(false);
  });
});
