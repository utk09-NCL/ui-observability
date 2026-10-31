// src/models/stats.ts
//
// Delivery state that getStats() gives to the app.

/** Delivery state of this context. A forwarder reports only its own buffers. */
export interface DeliveryStats {
  /** Records in a buffer of the library. No request carries them yet. */
  pending: number;
  /** Records in requests that have not completed. */
  inFlight: number;
  /** Batches in storage that wait for a retry. */
  stored: number;
  /** Epoch time in milliseconds when the server last accepted a batch, or null. */
  lastSendAt: number | null;
}
