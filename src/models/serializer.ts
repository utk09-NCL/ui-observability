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
   * Serializes a batch of records to payload bytes.
   * The transport calls it one time for each delivery attempt, not one time for each batch.
   * Thus each retry encodes the records again.
   * @param records Batch records, in log order.
   * @returns Serialized batch ready for transport.
   */
  serialize(records: LogRecord[]): SerializedBatch;
}
