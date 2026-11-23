// src/utils/patch.ts
//
// Replaces a host function with a wrapper and returns a safe restore. A router or a second
// SDK can wrap the same function after we do, and a blind restore would remove that wrapper
// and break the host page.

import { hasOwn } from "./guards";

/**
 * Replaces `target[key]` with a wrapper around the current value.
 * @param target The object that holds the function, for example `console` or `globalThis`.
 * @param key The property to replace.
 * @param wrap Builds the wrapper from the original value.
 * @returns A restore function. It puts the original back and returns true only if the
 * property still holds the wrapper. Otherwise it changes nothing and returns false.
 */
export function patch<T extends object, K extends keyof T>(
  target: T,
  key: K,
  wrap: (original: T[K]) => T[K],
): () => boolean {
  const original = target[key];
  // history.pushState lives on the prototype. Writing it back as an own property would hide a
  // later patch of History.prototype from the page.
  const own = hasOwn(target, key);
  const wrapper = wrap(original);
  target[key] = wrapper;

  return () => {
    // Another script wrapped the property after us. Keep its wrapper.
    if (target[key] !== wrapper) {
      return false;
    }

    if (own) {
      target[key] = original;
    } else {
      Reflect.deleteProperty(target, key);
    }

    return true;
  };
}
