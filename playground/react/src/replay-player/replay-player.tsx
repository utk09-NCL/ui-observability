// src/replay-player/replay-player.tsx
//
// Plays a list of recorder events with rrweb-player. The npm package of the library ships no
// player. A team builds the viewer into its own tooling, as this folder does.

import { type ReactElement, useEffect, useRef } from "react";
import Player from "rrweb-player";
import "rrweb-player/dist/style.css";
import type { ReplayEvent } from "./replay-api";

/** Fewest events that make a replay. The first two are the meta event and the full snapshot. */
const MIN_EVENTS = 2;

/**
 * Renders the player. A new list of events replaces the player.
 * @param props The events and the size of the stage in pixels.
 * @returns The stage of the player.
 */
export function ReplayPlayer({
  events,
  width,
  height,
}: {
  events: readonly ReplayEvent[];
  width: number;
  height: number;
}): ReactElement {
  const stage = useRef<HTMLDivElement>(null);

  // The player is a Svelte component. The cleanup destroys it and empties the stage, because a
  // second player on the stage would play on top of the first. StrictMode runs this twice.
  useEffect(() => {
    const element = stage.current;
    if (!element || events.length < MIN_EVENTS) {
      return;
    }

    const player = new Player({
      target: element,
      props: { events: [...events], width, height, autoPlay: true },
    });

    return () => {
      // The types of rrweb-player don't expose the destroy function.
      (player as { $destroy?: () => void }).$destroy?.();
      element.replaceChildren();
    };
  }, [events, width, height]);

  return <div ref={stage} className="replay-stage" />;
}
