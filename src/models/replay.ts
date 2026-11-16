// src/models/replay.ts
//
// Session replay types. The library records with the app's own recorder package, keeps the
// recent events in memory, and sends them in segments after an error.

/** A recorder event. The library only looks at the type. */
export interface ReplayEvent {
  /** The recorder's event type. 4 is the meta event that starts a full snapshot. */
  type: number;
}

/** The parts of the `record` function from `@rrweb/record` that the library uses. */
export interface ReplayRecord {
  /**
   * Starts the recorder.
   * @param options Recorder options.
   * @returns A function that stops the recorder, or undefined.
   */
  (options: Record<string, unknown>): (() => void) | undefined;
  /** Takes a full snapshot right now. Not every recorder version has it. */
  takeFullSnapshot?: (isCheckout?: boolean) => void;
  /** Looks up the DOM node for a recorder node id. Not every recorder version has it. */
  mirror?: { getNode: (id: number) => unknown };
}

/** Loads the recorder package. The app owns the import, e.g. `import("@rrweb/record")`. */
export type ReplayLoader = () => Promise<{ record: ReplayRecord }>;

/** What the library passes to a plugin loader. */
export interface ReplayPluginTools {
  /**
   * A ready-made `transformRequestFn` for the recorder's network plugin. It skips requests to
   * any URL in `capture.ignoreUrls`, which includes every library endpoint and the replay
   * endpoint. It also strips the query and fragment from URLs unless `capture.fullUrls` is set.
   * @param request The network plugin's request.
   * @returns The request to record, or undefined to skip it.
   */
  transformRequest: <T extends { name: string }>(request: T) => T | undefined;
}

/** Creates one of the recorder's record plugins. The app owns the import of the plugin package. */
export type ReplayPluginLoader = (tools: ReplayPluginTools) => unknown;

/** One chunk of a replay upload. */
export interface ReplaySegment {
  /** Recording id. Every recorder start gets a new one. */
  "replay.id": string;
  /** Session id from the record that triggered the upload. */
  "session.id": string;
  /** Tab id from the record that triggered the upload. */
  "tab.id": string;
  /** The runtime's service name. */
  "service.name": string;
  /** Position of the segment within its recording, starting at 0. */
  sequence: number;
  /** Number of events in the segment. */
  events: number;
  /** Length of the payload. */
  bytes: number;
  /** The event list as JSON text. */
  payload: string;
}

/** What triggers an upload. `onError` uploads after an ERROR or FATAL record. */
export type ReplayMode = "onError";
