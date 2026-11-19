// tests/replay-buffer.test.ts
//
// Tests for the session replay buffer. Events are short strings here, and type 4 is the meta
// event that starts a full snapshot.

import { describe, expect, it } from "vitest";
import { ReplayBuffer } from "../src/capture/replay-buffer";

/** Event type of the meta event. */
const META = 4;

/** Event type of a full snapshot. */
const SNAPSHOT = 2;

/** Event type of an incremental snapshot. */
const CHANGE = 3;

/**
 * Builds a buffer with a limit the test can change.
 * @param maxBytes Initial size limit.
 * @returns The buffer and the limit object.
 */
function setup(maxBytes = 1000) {
  const limit = { maxBytes };
  return { buffer: new ReplayBuffer(() => limit.maxBytes), limit };
}

/**
 * Adds the two events of a full snapshot.
 * @param buffer The test's buffer.
 * @param name Text that identifies the snapshot.
 * @param isCheckout Pass false for a recorder's first snapshot.
 */
function snapshot(buffer: ReplayBuffer, name: string, isCheckout = true): void {
  buffer.add(`meta-${name}`, META, isCheckout);
  buffer.add(`full-${name}`, SNAPSHOT, isCheckout);
}

describe("ReplayBuffer", () => {
  it("returns every event in order and is empty afterwards", () => {
    const { buffer } = setup();

    snapshot(buffer, "a", false);
    buffer.add("c1", CHANGE, false);
    buffer.add("c2", CHANGE, false);

    expect(buffer.take()).toEqual({ texts: ["meta-a", "full-a", "c1", "c2"], lost: 0 });
    expect(buffer.take()).toEqual({ texts: [], lost: 0 });
  });

  it("starts one part for the meta event and the snapshot of a checkout", () => {
    const { buffer } = setup();

    // Four checkouts. If every checkout event opened a part, the buffer would keep too few.
    for (const name of ["a", "b", "c", "d"]) {
      snapshot(buffer, name);
      buffer.add(`c-${name}`, CHANGE, false);
    }

    expect(buffer.take().texts).toEqual([
      "meta-b",
      "full-b",
      "c-b",
      "meta-c",
      "full-c",
      "c-c",
      "meta-d",
      "full-d",
      "c-d",
    ]);
  });

  it("drops the oldest part above the size limit and counts its events", () => {
    const { buffer } = setup(29);

    snapshot(buffer, "a", false);
    buffer.add("c1", CHANGE, false);
    // The first part is 14 characters. With the second part the total goes to 28 and then 30.
    snapshot(buffer, "b");
    buffer.add("c2", CHANGE, false);
    buffer.add("c3", CHANGE, false);

    expect(buffer.take()).toEqual({ texts: ["meta-b", "full-b", "c2", "c3"], lost: 3 });
    expect(buffer.take().lost).toBe(0);
  });

  it("drops its only part above the size limit and waits for the next snapshot", () => {
    const { buffer } = setup(20);

    snapshot(buffer, "a", false);
    buffer.add("a-long-change-event", CHANGE, false);
    // The buffer has no snapshot now, so a player can't use these events.
    buffer.add("c1", CHANGE, false);
    buffer.add("full-with-no-meta", SNAPSHOT, true);

    expect(buffer.take()).toEqual({ texts: [], lost: 5 });

    snapshot(buffer, "b");
    buffer.add("c2", CHANGE, false);

    expect(buffer.take()).toEqual({ texts: ["meta-b", "full-b", "c2"], lost: 0 });
  });

  it("stays starved after a take, so the events after it wait for the next snapshot", () => {
    const { buffer } = setup(20);

    snapshot(buffer, "a", false);
    buffer.add("a-long-change-event", CHANGE, false);
    buffer.take();
    // A failed snapshot at the error leaves the buffer here. These events have no snapshot.
    buffer.add("c1", CHANGE, false);
    expect(buffer.take()).toEqual({ texts: [], lost: 1 });

    snapshot(buffer, "b");
    expect(buffer.take()).toEqual({ texts: ["meta-b", "full-b"], lost: 0 });
  });

  it("forgets the dropped events at clear(), so a new recording doesn't report them", () => {
    const { buffer } = setup(20);

    snapshot(buffer, "a", false);
    buffer.add("a-long-change-event", CHANGE, false);
    // A stop or a new session clears the buffer, and the next upload belongs to a new recording.
    buffer.clear();
    snapshot(buffer, "b", false);

    expect(buffer.take()).toEqual({ texts: ["meta-b", "full-b"], lost: 0 });
  });

  it("reads the size limit at each event", () => {
    const { buffer, limit } = setup(1000);

    snapshot(buffer, "a", false);
    snapshot(buffer, "b");
    limit.maxBytes = 15;
    buffer.add("c1", CHANGE, false);

    expect(buffer.take().texts).toEqual(["meta-b", "full-b", "c1"]);
  });

  it("takes events again after clear(), and after a take of a buffer that isn't starved", () => {
    const { buffer } = setup(20);

    snapshot(buffer, "a", false);
    buffer.add("a-long-change-event", CHANGE, false);
    buffer.clear();
    buffer.add("c1", CHANGE, false);

    // clear() also stops waiting for a snapshot. The capture asks for a new one afterwards.
    expect(buffer.take().texts).toEqual(["c1"]);

    buffer.add("c2", CHANGE, false);
    expect(buffer.take().texts).toEqual(["c2"]);
  });
});
