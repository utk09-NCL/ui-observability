// src/models/stats.ts
//
// Delivery state that getStats() returns to the app.

/** Delivery state of this context. A forwarder reports only its own buffers. */
export interface DeliveryStats {
  /** Records in one of the library's buffers, not yet in any request. */
  pending: number;
  /** Records in requests that have not completed. */
  inFlight: number;
  /** Batches in storage waiting for a retry. */
  stored: number;
  /** Epoch time in milliseconds when the server last accepted a batch, or null. */
  lastSendAt: number | null;
}
