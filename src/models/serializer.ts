// src/models/serializer.ts
//
// Interface that converts log records into payload bytes.

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
   * Serializes a batch of records to payload bytes. The transport calls it once per delivery
   * attempt, not once per batch, so every retry encodes the records again. Make every record
   * valid for your server, for example by cutting fields to its limits, because the library
   * drops a batch that the server refuses with a 400.
   * @param records Batch records, in log order.
   * @returns Serialized batch ready for transport.
   */
  serialize(records: LogRecord[]): SerializedBatch;
}
