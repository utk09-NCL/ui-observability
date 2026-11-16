// src/utils/error-like.ts
//
// Detects an error by its shape. An error from another realm, for example an iframe,
// fails `instanceof Error`.

/** The standard error fields. Any other own field is written as error data. */
export const ERROR_OWN_KEYS: ReadonlySet<string> = new Set(["name", "message", "stack", "cause"]);

/**
 * Checks whether a value is a field that error data keeps. An object field, such as an
 * AxiosError's config, holds credentials and request bodies.
 * @param value Field value.
 * @returns True for a string, a number or a boolean.
 */
export function isDataField(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** The error fields that the library reads. */
export interface ErrorLike {
  /** Error class name, for example "TypeError". */
  name: string;
  /** Error message. */
  message: string;
  /** Stack trace text. */
  stack?: string;
}

/**
 * Checks whether a value has the shape of an error. A getter on a hostile value can throw, so
 * call this inside a diagnostics guard.
 * @param value The value to check.
 * @returns True for an object with a string name, a string message and a string or no stack.
 */
export function isErrorLike(value: unknown): value is ErrorLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.message === "string" &&
    (candidate.stack === undefined || typeof candidate.stack === "string")
  );
}
