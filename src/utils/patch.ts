// src/utils/patch.ts
//
// Replaces a host function with a wrapper and gives back a safe restore. A router or a
// second SDK can wrap the same function after the library. A blind restore removes that
// wrapper and breaks the host page.

/**
 * Replaces `target[key]` with a wrapper of the current value.
 * @param target Object that holds the function, for example `console` or `globalThis`.
 * @param key Property to replace.
 * @param wrap Makes the wrapper from the original value.
 * @returns Restore function. It writes the original back only if the property still holds
 * the wrapper. It then returns true. If not, it changes nothing. It returns false.
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
    // Another script wrapped the property after the library. Keep its wrapper.
    if (target[key] !== wrapper) {
      return false;
    }

    target[key] = original;
    return true;
  };
}
