// src/panels/support-panel.tsx
//
// What a support engineer needs: the replays that the app uploaded after an error, the health
// of the library, the debug bundle and the reports of lost records. The replay list and the
// player are in replay-player/, and a team can copy that folder alone.

import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import {
  collectDebugBundle,
  getHealth,
  getLogger,
  type ObservabilityHealth,
} from "@utk09/ui-observability";
import { readDrops, type TappedDrop } from "../observability-settings/tap";
import {
  listRecordings,
  loadRecordingEvents,
  type RecordingHead,
  type ReplayEvent,
} from "../replay-player/replay-api";
import { ReplayPlayer } from "../replay-player/replay-player";

const log = getLogger("support");
const DROP_POLL_MS = 1000;
const BUNDLE_PREVIEW_CHARS = 1500;
const MIN_STAGE_WIDTH = 320;
const STAGE_RATIO = 0.6;

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** The recordings of the replay service, and the player. */
function Replays(): ReactElement {
  const [heads, setHeads] = useState<RecordingHead[] | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState<{ id: string; events: ReplayEvent[] } | null>(null);
  const [size, setSize] = useState({ width: MIN_STAGE_WIDTH, height: 200 });
  const box = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setHeads(await listRecordings());
      setError("");
    } catch (reason) {
      log.warn("The replay list did not load.", { reason: String(reason) });
      setError(reason instanceof Error ? reason.message : "The replay list did not load.");
    }
  }, []);

  // One load at the start. The list has no timer, because each request of the page is a record
  // of the library too. The button asks again. StrictMode runs this twice, and a list is harmless.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const play = async (id: string): Promise<void> => {
    try {
      const events = await loadRecordingEvents(id);
      const width = Math.max(MIN_STAGE_WIDTH, box.current?.clientWidth ?? MIN_STAGE_WIDTH);
      setSize({ width, height: Math.round(width * STAGE_RATIO) });
      setPlaying({ id, events });
      setError(events.length < 2 ? "The recording has too few events to play." : "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The recording did not load.");
    }
  };

  return (
    <section aria-labelledby="support-replays">
      <h3 id="support-replays">Replays</h3>
      <p className="muted">
        The library uploads the last minute of the page after an ERROR record, for a user who agreed
        in Privacy choices. Place an order with the fault switch on <strong>Reject, 422</strong>,
        and a recording appears after a few seconds.
      </p>
      <div className="controls">
        <button
          type="button"
          data-observability-action="refresh-replays"
          onClick={() => {
            void refresh();
          }}
        >
          Refresh the list
        </button>
      </div>
      <p role="alert" className="warn">
        {error}
      </p>
      <div className="table-scroll" ref={box}>
        <table className="replays">
          <thead>
            <tr>
              <th scope="col">Recording</th>
              <th scope="col">Started</th>
              <th scope="col">Segments</th>
              <th scope="col">Events</th>
              <th scope="col">Size</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(heads ?? []).map((head) => (
              <tr key={head.id}>
                <td>
                  <code>{head.id.slice(0, 8)}</code>
                </td>
                <td>{head.startedAt.slice(11, 19)}</td>
                <td>{head.segments}</td>
                <td>{head.events}</td>
                <td>{megabytes(head.bytes)}</td>
                <td>
                  <button
                    type="button"
                    aria-label={`Play ${head.id.slice(0, 8)}`}
                    data-observability-action="play-replay"
                    onClick={() => {
                      void play(head.id);
                    }}
                  >
                    Play
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {heads?.length === 0 && <p className="muted">The service has no recording yet.</p>}
      </div>
      {playing && <ReplayPlayer events={playing.events} width={size.width} height={size.height} />}
    </section>
  );
}

/** The result of getHealth(). */
function Health(): ReactElement {
  const [health, setHealth] = useState<ObservabilityHealth | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setHealth(await getHealth());
  }, []);

  useEffect(() => {
    let active = true;
    void getHealth().then((next) => {
      if (active) {
        setHealth(next);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  return (
    <section aria-labelledby="support-health">
      <h3 id="support-health">Health</h3>
      <div className="controls">
        <button
          type="button"
          data-observability-action="refresh-health"
          onClick={() => {
            void refresh();
          }}
        >
          Read the health
        </button>
      </div>
      {health && (
        <>
          <dl className="strip">
            <div>
              <dt>Status</dt>
              <dd data-testid="health-status">{health.status}</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{health.mode}</dd>
            </div>
            <div>
              <dt>Issues</dt>
              <dd>{health.issues.length === 0 ? "none" : health.issues.join(", ")}</dd>
            </div>
            <div>
              <dt>Pending</dt>
              <dd>{health.delivery.pending}</dd>
            </div>
          </dl>
          <details>
            <summary>The whole answer</summary>
            <pre className="json">{JSON.stringify(health, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  );
}

/** The result of collectDebugBundle(). */
function Bundle(): ReactElement {
  const [bundle, setBundle] = useState<{ text: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // The download link points to a Blob. The cleanup frees the Blob when the bundle changes.
  useEffect(
    () => () => {
      if (bundle) {
        URL.revokeObjectURL(bundle.url);
      }
    },
    [bundle],
  );

  const collect = async (): Promise<void> => {
    setBusy(true);
    try {
      const text = JSON.stringify(await collectDebugBundle(), null, 2);
      setBundle({ text, url: URL.createObjectURL(new Blob([text], { type: "application/json" })) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="support-bundle">
      <h3 id="support-bundle">Debug bundle</h3>
      <p className="muted">
        The bundle holds the health, the diagnostic counters, the resource, the breadcrumbs, the
        debug buffer and a summary of the config. It has no header and no URL query. The app decides
        where it goes.
      </p>
      <div className="controls">
        <button
          type="button"
          disabled={busy}
          data-observability-action="collect-bundle"
          onClick={() => {
            void collect();
          }}
        >
          Collect the bundle
        </button>
        {bundle && (
          <a href={bundle.url} download="uiobs-debug-bundle.json">
            Download
          </a>
        )}
      </div>
      {bundle && (
        <>
          <p className="muted" data-testid="bundle-size">
            {bundle.text.length} characters.
          </p>
          <pre className="json">
            {bundle.text.slice(0, BUNDLE_PREVIEW_CHARS)}
            {bundle.text.length > BUNDLE_PREVIEW_CHARS ? "\n..." : ""}
          </pre>
        </>
      )}
    </section>
  );
}

/** The loss reports that the onDrop hook of the config received. */
function Drops(): ReactElement {
  const [drops, setDrops] = useState<readonly TappedDrop[]>(readDrops);

  // The tap is local data. The state changes only when a report is new, so the list writes
  // nothing to the DOM in a quiet second.
  useEffect(() => {
    const timer = setInterval(() => {
      const next = readDrops();
      setDrops((previous) => (previous.at(-1)?.id === next.at(-1)?.id ? previous : next));
    }, DROP_POLL_MS);

    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <section aria-labelledby="support-drops">
      <h3 id="support-drops">Lost records</h3>
      <p className="muted">
        The <code>onDrop</code> hook gets a summary for each loss, with the reason and the number of
        records. Privacy choices and a shared-device logout discard the records that were not sent.
      </p>
      {drops.length === 0 ? (
        <p className="muted">The library lost no record in this page.</p>
      ) : (
        <ul className="diagnostics" aria-label="Loss reports">
          {[...drops].reverse().map((drop) => (
            <li key={drop.id}>
              <code>{drop.summary.reason}</code> {drop.summary.records} records
              {drop.summary.actions.length > 0 && (
                <> of the actions {drop.summary.actions.join(", ")}</>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Renders the Support panel.
 * @returns The panel.
 */
export function SupportPanel(): ReactElement {
  return (
    <div className="panel support-panel" aria-label="Support">
      <Replays />
      <Health />
      <Bundle />
      <Drops />
    </div>
  );
}
