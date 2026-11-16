// src/utils/patch.ts
//
// Replaces a host function with a wrapper and returns a safe restore. A router or a second
// SDK can wrap the same function after we do, and a blind restore would remove that wrapper
// and break the host page.

/**
 * Replaces `target[key]` with a wrapper around the current value.
 * @param target The object that holds the function, for example `console` or `globalThis`.
 * @param key The property to replace.
 * @param wrap Builds the wrapper from the original value.
 * @returns A restore function. It writes the original back and returns true only if the
 * property still holds the wrapper. Otherwise it changes nothing and returns false.
 */
export function patch<T extends object, K extends keyof T>(
  target: T,
  key: K,
  wrap: (original: T[K]) => T[K],
): () => boolean {
  const original = target[key];
  const wrapper = wrap(original);
  target[key] = wrapper;

  return () => {
    // Another script wrapped the property after us. Keep its wrapper.
    if (target[key] !== wrapper) {
      return false;
    }

    target[key] = original;
    return true;
  };
}
