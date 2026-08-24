// src/models/serializer.ts
//
// The seam between records and bytes. Everything upstream works with
// `LogRecord`; only an implementation of this interface knows the wire format.

import type { LogRecord } from "./log-record";

/** One batch as the bytes to send, plus the content type describing them. */
export interface SerializedBatch {
  /** The request body. */
  body: string;
  /** The value for the request's `Content-Type` header. */
  contentType: string;
}

/** Turns records into a wire payload. */
export interface LogSerializer {
  /** The spelling a consumer selects this format by in configuration. */
  name: string;
  /**
   * Encode one batch.
   *
   * Called per delivery attempt, not per batch, so a retry re-encodes. That
   * keeps a stored batch as records, which a later version of this library can
   * still read, rather than as bytes in a format it may no longer speak.
   *
   * @param records The batch's records, in the order they were logged.
   */
  serialize(records: LogRecord[]): SerializedBatch;
}
