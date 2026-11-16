// src/utils/guards.ts
//
// Type guards for values that come from outside the library, such as config input, a server
// answer or a call's payload.

/**
 * Checks whether a value is a non-null object that isn't an array.
 * @param value The value to check.
 * @returns True for an object with string keys.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
