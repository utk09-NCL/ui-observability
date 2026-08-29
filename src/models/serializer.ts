// src/models/serializer.ts
//
// Interface for converting log records into wire-format bytes.

import type { LogRecord } from "./log-record";

/**
 * Serialized batch payload with its content type.
 * @see {@link LogSerializer}
 */
export interface SerializedBatch {
  /** Request body bytes. */
  body: string;
  /** Content-Type header value. */
  contentType: string;
}

/** Log record serializer interface. */
export interface LogSerializer {
  /** Serializer name used in configuration. */
  name: string;
  /**
   * Serializes a batch of records to wire-format bytes.
   * Called once per delivery attempt, not once per batch, so a retry re-encodes.
   * @param records Batch records, in log order.
   * @returns Serialized batch ready for transport.
   */
  serialize(records: LogRecord[]): SerializedBatch;
}
