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

/**
 * Checks whether a key is the object's own property, so an inherited "toString" fails. It
 * replaces Object.hasOwn, which is missing before Chrome 93, Firefox 92 and Safari 15.4.
 * @param object The object to check.
 * @param key The property key.
 * @returns True if the object has its own property with this key.
 */
export function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
