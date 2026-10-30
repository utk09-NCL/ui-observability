// src/utils/guards.ts
//
// Type guards for values from outside the library, for example config input, a server answer or
// the payload of a call.

/**
 * Tests if a value is an object that is not null and not an array.
 * @param value Value to test.
 * @returns True for an object with string keys.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
