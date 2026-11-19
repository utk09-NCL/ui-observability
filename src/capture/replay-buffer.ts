// src/capture/replay-buffer.ts
//
// Keeps the recent session replay events in memory as JSON text. Events are grouped into
// parts, and every part starts with a full snapshot, so a player can start from any of them.

/** Event type of the meta event. The recorder sends it right before a full snapshot. */
const META_EVENT = 4;

/** How many parts we keep. With a snapshot every half window, 3 parts cover a full window. */
const KEPT_PARTS = 3;

/** Size-limited ring of recent replay events. */
export class ReplayBuffer {
  /** Events per part, as JSON text. The last part is the open one. */
  private parts: string[][] = [];

  /** Size of each part: the sum of its text lengths. */
  private sizes: number[] = [];

  /** Size of all parts together. */
  private total = 0;

  /**
   * True after the buffer had to drop its only part. Everything up to the next full snapshot
   * has no snapshot in front of it, which makes it useless to a player.
   */
  private starved = false;

  /** Events dropped by the size limit since the last take. */
  private lost = 0;

  /**
   * @param maxBytes Returns the size limit for all parts together.
   */
  constructor(private readonly maxBytes: () => number) {}

  /**
   * Adds one event.
   * @param text The event as JSON text.
   * @param type The recorder's event type.
   * @param isCheckout True for the events of a new full snapshot.
   * @returns True if this event made the buffer drop its only part.
   */
  add(text: string, type: number, isCheckout: boolean): boolean {
    // The meta event and the snapshot both carry the flag, but only the meta event opens a part.
    const opens = isCheckout && type === META_EVENT;

    if (this.starved && !opens) {
      this.lost++;
      return false;
    }

    if (opens || this.parts.length === 0) {
      this.starved = false;
      this.parts.push([]);
      this.sizes.push(0);

      if (this.parts.length > KEPT_PARTS) {
        this.dropOldest();
      }
    }

    const last = this.parts.length - 1;
    this.parts[last].push(text);
    this.sizes[last] += text.length;
    this.total += text.length;

    const limit = this.maxBytes();
    while (this.total > limit && this.parts.length > 0) {
      // Nothing with a snapshot comes after the last part, so once it goes the events that
      // follow can't be played.
      this.starved = this.parts.length === 1;
      this.lost += this.dropOldest();
    }

    return this.starved;
  }

  /**
   * Returns every event in order with the dropped count, and empties the buffer. A starved
   * buffer stays starved, because the events after a take still have no snapshot in front.
   * @returns The events as JSON text, and how many events the size limit dropped.
   */
  take(): { texts: string[]; lost: number } {
    const taken = { texts: this.parts.flat(), lost: this.lost };
    this.parts = [];
    this.sizes = [];
    this.total = 0;
    this.lost = 0;
    return taken;
  }

  /** Empties the buffer and its dropped count, so the next upload doesn't report old drops. */
  clear(): void {
    this.parts = [];
    this.sizes = [];
    this.total = 0;
    this.starved = false;
    this.lost = 0;
  }

  /**
   * Removes the oldest part.
   * @returns The number of events in that part.
   */
  private dropOldest(): number {
    const [part] = this.parts.splice(0, 1);
    const [size] = this.sizes.splice(0, 1);
    this.total -= size;
    return part.length;
  }
}
