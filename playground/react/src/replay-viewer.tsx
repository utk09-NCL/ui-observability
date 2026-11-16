// playground/react/src/replay-viewer.tsx
//
// Viewer for the replay spike. It lists the recordings in the playground's IndexedDB store and
// plays one with rrweb-player. The library's npm package doesn't ship a player: a company would
// build the viewer into its own tooling, the way this page does.

import { getReplayConsolePlugin } from "@rrweb/rrweb-plugin-console-replay";
import { getReplayNetworkPlugin } from "@rrweb/rrweb-plugin-network-replay";
import { getReplaySequentialIdPlugin } from "@rrweb/rrweb-plugin-sequential-id-replay";
import { type ReactElement, StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Player from "rrweb-player";
import "rrweb-player/dist/style.css";
import {
  clearRecordings,
  deleteRecording,
  listRecordings,
  loadEvents,
  type RecordingHead,
  STORE_LIMITS,
} from "./replay-store";

/** A recording's events, in the shape the player takes. */
type PlayerEvents = ConstructorParameters<typeof Player>[0]["props"]["events"];

/** What the page knows about the recording that is playing. */
interface Played {
  id: string;
  events: number;
  networkRequests: string[];
}

/**
 * Formats a size.
 * @param bytes Size in characters.
 * @returns The size in MB, with two decimals.
 */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * The viewer page.
 * @returns Root element.
 */
function Viewer(): ReactElement {
  const [heads, setHeads] = useState<RecordingHead[]>([]);
  const [played, setPlayed] = useState<Played | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);

  const refresh = useCallback(async (): Promise<RecordingHead[]> => {
    const next = await listRecordings();
    setHeads(next);
    return next;
  }, []);

  /** Tears down the player. A second player on the page would play on top of the first. */
  const stop = useCallback((): void => {
    // rrweb-player is a Svelte component, and its types don't expose the destroy function.
    (player.current as { $destroy?: () => void } | null)?.$destroy?.();
    player.current = null;
    stage.current?.replaceChildren();
    setPlayed(null);
  }, []);

  const play = useCallback(
    async (id: string): Promise<void> => {
      stop();
      const events = (await loadEvents(id)) as PlayerEvents;
      const networkRequests: string[] = [];

      if (!stage.current || events.length < 2) {
        return;
      }

      player.current = new Player({
        target: stage.current,
        props: {
          events,
          width: 1000,
          height: 520,
          autoPlay: true,
          plugins: [
            // Warns in the console when an event is missing or out of order.
            getReplaySequentialIdPlugin(),
            // Prints every recorded warning and error to this page's console.
            getReplayConsolePlugin(),
            getReplayNetworkPlugin({
              onNetworkData: (data) => {
                networkRequests.push(...data.requests.map((request) => request.name));
                setPlayed((current) => (current ? { ...current, networkRequests } : current));
              },
            }),
          ],
        },
      });
      setPlayed({ id, events: events.length, networkRequests });
    },
    [stop],
  );

  useEffect(() => {
    // Loading the list has no side effects outside the page, so a second run under StrictMode
    // is harmless.
    void refresh().then((next) => {
      if (next.length > 0 && new URLSearchParams(location.search).get("autoplay") === "1") {
        return play(next[0].id);
      }

      return undefined;
    });

    return stop;
  }, [refresh, play, stop]);

  const total = heads.reduce((sum, head) => sum + head.bytes, 0);

  return (
    <>
      <h1>replay viewer</h1>
      <p>
        The store is IndexedDB of this origin. It keeps at most {STORE_LIMITS.maxRecordings}{" "}
        recordings and {megabytes(STORE_LIMITS.maxBytes)}. A new recording removes the oldest ones
        above a limit. It also removes a recording that is older than 7 days.
      </p>
      <p id="usage">
        {heads.length} recordings, {megabytes(total)} of {megabytes(STORE_LIMITS.maxBytes)}.
      </p>
      <p>
        <button
          type="button"
          onClick={() => {
            stop();
            void clearRecordings().then(refresh);
          }}
        >
          Delete each recording
        </button>
      </p>
      <table>
        <thead>
          <tr>
            <th>Saved</th>
            <th>Session</th>
            <th>Segments</th>
            <th>Events</th>
            <th>Size</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {heads.map((head) => (
            <tr key={head.id}>
              <td>{new Date(head.createdAt).toISOString()}</td>
              <td>{head.sessionId}</td>
              <td>{head.segments}</td>
              <td>{head.events}</td>
              <td>{megabytes(head.bytes)}</td>
              <td>
                <button type="button" onClick={() => void play(head.id)}>
                  Play
                </button>{" "}
                <button
                  type="button"
                  onClick={() => {
                    if (played?.id === head.id) {
                      stop();
                    }
                    void deleteRecording(head.id).then(refresh);
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre id="result-json">
        {JSON.stringify({ recordings: heads.length, bytes: total, played }, null, 2)}
      </pre>
      <div ref={stage} id="stage" />
    </>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("replay-viewer.html is missing #root");
}

createRoot(container).render(
  <StrictMode>
    <Viewer />
  </StrictMode>,
);
