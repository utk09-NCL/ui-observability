// bench/replay.js
//
// The replay workload. It has its own page because it imports the optional peer @rrweb/record
// by name, and that import fails where the peer isn't installed. tools/bench-release.mjs opens
// this page only when the peer is there.

/* global crossOriginIsolated, document, performance, window */

import { error, flush } from "../src/index";
import {
  MS_PER_SECOND,
  US_PER_MS,
  clockTickUs,
  losses,
  nextTask,
  sleep,
  spread,
  startInMemory,
} from "./shared.js";

/** The longest wait for the first replay segment after the error, in ms. */
const SEGMENT_WAIT_MS = 10_000;

/**
 * Times rounds of DOM changes with the replay recorder on or off. A round ends after one
 * microtask, because the recorder handles mutations in a microtask and that cost belongs to the
 * round.
 * @param params replayOn, warmupRounds, rounds, changesPerRound and maxBufferBytes.
 * @returns Percentiles of one round in microseconds, and the recorder events that were sent.
 */
async function replay({ replayOn, warmupRounds, rounds, changesPerRound, maxBufferBytes }) {
  let replayEvents = 0;

  await startInMemory({
    replay: {
      enabled: replayOn,
      maxBufferBytes,
      loader: () => import("@rrweb/record"),
      onSegment: (segment) => {
        replayEvents += segment.events;
      },
    },
  });

  // The wait lets the recorder load and take its first snapshot before the timed rounds.
  await sleep(MS_PER_SECOND);

  const list = document.querySelector("#rows");
  const samplesUs = new Float64Array(rounds);

  for (let round = -warmupRounds; round < rounds; round++) {
    const before = performance.now();

    for (let change = 0; change < changesPerRound; change++) {
      const row = document.createElement("li");
      row.textContent = `row ${String(round)} ${String(change)}`;
      list.append(row);
      row.setAttribute("data-state", "filled");
    }

    await Promise.resolve();

    if (round >= 0) {
      samplesUs[round] = (performance.now() - before) * US_PER_MS;
    }

    list.replaceChildren();
    await nextTask();
  }

  // An error makes the library send its replay buffer. That proves the recorder really ran.
  error("bench replay probe", new Error("bench"));
  await flush();

  for (let waited = 0; replayOn && replayEvents === 0 && waited < SEGMENT_WAIT_MS; waited += 100) {
    await sleep(100);
  }

  return {
    crossOriginIsolated,
    clockTickUs: clockTickUs(),
    perRoundUs: spread(samplesUs),
    replayEvents,
    ...losses,
  };
}

window.bench = { replay };
