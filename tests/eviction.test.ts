import { describe, expect, it } from "vitest";
import type { LogBatch } from "../src/models/batch";
import type { LogRecord } from "../src/models/log-record";
import { EvictionPick, hasAction, pickEvictable } from "../src/storage/eviction";

const record = (type: string): LogRecord =>
  ({ body: type, attributes: { "log.type": type } }) as unknown as LogRecord;

const batchOf = (id: string, records: LogRecord[]): LogBatch => ({
  id,
  createdAt: Date.now(),
  attempts: 0,
  records,
});

const audit = (id: string) => id.startsWith("a");

describe("hasAction", () => {
  it("finds an action in a batch", () => {
    expect(hasAction(batchOf("a", [record("log"), record("action")]))).toBe(true);
    expect(hasAction(batchOf("p", [record("log")]))).toBe(false);
  });

  it("reads a stored batch with no record list as a batch without an action", () => {
    // Another script on the origin can write any value to the database.
    expect(hasAction({ id: "x" } as LogBatch)).toBe(false);
  });
});

describe("pickEvictable", () => {
  it("picks the items without an audit fact first and keeps their age order", () => {
    expect(pickEvictable(["a1", "p1", "a2", "p2"], 3, audit)).toEqual(["p1", "p2", "a1"]);
  });

  it("stops the walk when it has enough items without an audit fact", () => {
    const read: string[] = [];
    function* walk(): Generator<string> {
      for (const id of ["a1", "p1", "p2", "p3"]) {
        read.push(id);
        yield id;
      }
    }

    expect(pickEvictable(walk(), 1, audit)).toEqual(["p1"]);
    expect(read).toEqual(["a1", "p1"]);
  });

  it("keeps at most the asked number of items with an audit fact", () => {
    const pick = new EvictionPick(2, audit);
    for (const id of ["a1", "a2", "a3"]) {
      pick.add(id);
    }

    expect(pick["audit"]).toEqual(["a1", "a2"]);
    expect(pick.picked()).toEqual(["a1", "a2"]);
  });
});
