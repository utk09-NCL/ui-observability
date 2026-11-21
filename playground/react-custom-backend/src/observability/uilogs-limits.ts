// src/observability/uilogs-limits.ts
//
// The limits of the example uilogs server. tools/mock-ingest-server.mjs has the same four
// numbers in UILOGS_LIMITS. Change both together. A real backend has its own limits.

/** Longest message, in characters. */
export const MAX_MESSAGE_CHARS = 2000;

/** Most keys in the attributes of one record. */
export const MAX_ATTRIBUTE_KEYS = 50;

/** Largest attributes object of one record, as UTF-8 JSON bytes. */
export const MAX_ATTRIBUTES_BYTES = 16384;

/**
 * Most records in one request. The server answers 413 above it, and the library splits the
 * batch. The serializer doesn't enforce it, because an exit batch has no fixed size.
 */
export const MAX_RECORDS = 500;
