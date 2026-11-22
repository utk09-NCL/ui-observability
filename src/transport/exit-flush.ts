// src/transport/exit-flush.ts
//
// Flushes buffered batches on exit with sendBeacon, a keepalive fetch or emergency storage.
// It runs during unload, so nothing in here awaits. A hidden document is still running, so it
// gets a normal flush.

import {
  BEACON_LIMIT_BYTES,
  CONTENT_TYPE_TEXT_PLAIN,
  HEADER_BATCH_ID,
  HEADER_CONTENT_TYPE,
  QUERY_PARAM_BATCH_ID,
  QUERY_PARAM_EXIT_REASON,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";
import type { ExitTransport, ResolvedConfig } from "../models/config";
import type { LossReporter } from "../models/drop";
import type { SerializedBatch } from "../models/serializer";
import { saveToEmergencyQueue } from "../storage/emergency-queue";
import { runAsLibraryRequest } from "../utils/library-request";
import { getFin } from "../utils/openfin";
import { estimateBytes } from "../utils/sanitize";
import { toTransportRequest } from "./custom-transport";
import { batchKind, endpointFor, serializeBatch } from "./serializers/select";

/** The lifecycle event or manual action that starts an exit flush. */
export type ExitReason = "hidden" | "pagehide" | "freeze" | "openfin-close" | "shutdown";

/**
 * The browser's answer to a beacon. `refused` means the in-flight budget is full.
 * `unavailable` means the host has no usable sendBeacon.
 */
type BeaconOutcome = "sent" | "refused" | "unavailable";

/** Lets us read navigator.sendBeacon without global DOM type assertions. */
interface BeaconGlobal {
  navigator?: { sendBeacon?: (url: string, data: Blob) => boolean };
}

/** Dependencies of ExitFlush. */
export interface ExitFlushDeps {
  /** The active configuration. */
  config: ResolvedConfig;
  /** Diagnostics reporter. */
  diagnostics: Diagnostics;
  /** Drains all buffered and unconfirmed records into one batch per kind. */
  drainForExit: () => LogBatch[];
  /**
   * Runs a normal flush with headers, gzip and retry. Used for a hidden document.
   * It doesn't touch an in-flight batch.
   */
  flushAlive: () => unknown;
  /**
   * Returns the headers that the HTTP transport sent last, or undefined. sendBeacon can't set
   * a header, so when there are headers the exit flush uses a keepalive fetch.
   */
  exitHeaders: () => Record<string, string> | undefined;
  /**
   * Returns the bytes of the HTTP transport's keepalive requests that haven't settled, or
   * undefined without an HTTP transport. A hidden page's sends use the exit sends' budget.
   */
  keepaliveInFlight: () => number | undefined;
  /** Receives the records that the exit flush loses. */
  onLoss?: LossReporter;
  /** Pushes the open metric interval's points into the buffers. */
  beforeExit?: () => void;
}

/**
 * Flushes pending telemetry on document unload, with sendBeacon, a keepalive fetch or
 * emergency storage.
 */
export class ExitFlush {
  /** True while we are listening for the unload events. */
  private installed = false;

  /**
   * True after a pagehide with no later pageshow. The batch timers won't fire in a closing
   * document, so a record that arrives now has to take the exit path.
   */
  private left = false;

  /** True while a late exit flush waits on its microtask, so one task's records go together. */
  private lateQueued = false;

  /**
   * Bytes in flight against the browser's one budget for beacons and keepalive fetches. It
   * starts at the transport's keepalive sends, and each batch of the current exit flush adds to it.
   */
  private keepaliveBytes = 0;

  /**
   * Bytes that the exit sends of this page leave put in flight. A late flush adds them, because
   * nothing tracks an exit send's completion and the browser rejects a send over its budget.
   */
  private leaveBytes = 0;

  /** Flushes on visibilitychange when the document becomes hidden. */
  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      this.flush("hidden");
    }
  };

  /** Flushes on the window's pagehide event. */
  private readonly onPageHide = (): void => {
    this.left = true;
    this.leaveBytes = 0;
    this.flush("pagehide");
  };

  /** Returns to the normal path when the back/forward cache restores the page. */
  private readonly onPageShow = (): void => {
    this.left = false;
    this.leaveBytes = 0;
  };

  /** Flushes on the document's freeze event. */
  private readonly onFreeze = (): void => {
    this.flush("freeze");
  };

  /** Flushes on the OpenFin close-requested event. */
  private readonly onOpenFinClose = (): void => {
    this.flush("openfin-close");
  };

  /**
   * @param deps Injected configuration, diagnostics, and drain callback.
   */
  constructor(private readonly deps: ExitFlushDeps) {}

  /** Attaches the unload listeners to the document, the window and OpenFin. */
  install(): void {
    if (this.installed || typeof addEventListener === "undefined") {
      return;
    }
    this.installed = true;

    if (typeof document !== "undefined") {
      // visibilitychange and freeze fire on the document. pagehide fires on the window.
      document.addEventListener("visibilitychange", this.onVisibility);
      document.addEventListener("freeze", this.onFreeze);
    }

    addEventListener("pagehide", this.onPageHide);
    addEventListener("pageshow", this.onPageShow);

    const me = getFin()?.me;
    this.deps.diagnostics.guard(
      "openfin.unavailable",
      "The library could not subscribe to close-requested.",
      () => {
        me?.on?.("close-requested", this.onOpenFinClose);
      },
    );
  }

  /** Removes all unload listeners and subscriptions. */
  uninstall(): void {
    if (!this.installed) {
      return;
    }
    this.installed = false;
    // Without the pageshow listener the flag can't clear, and a paused or stopped sender sends
    // nothing through this path.
    this.left = false;
    this.leaveBytes = 0;

    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
      document.removeEventListener("freeze", this.onFreeze);
    }

    removeEventListener("pagehide", this.onPageHide);
    removeEventListener("pageshow", this.onPageShow);

    const me = getFin()?.me;
    this.deps.diagnostics.guard(
      "openfin.unavailable",
      "The library could not unsubscribe from close-requested.",
      () => {
        me?.removeListener?.("close-requested", this.onOpenFinClose);
      },
    );
  }

  /**
   * Sends a record that reached the sender after pagehide with an exit send on a microtask, so
   * all records of one task go in one send. A web-vitals report arrives this late on a page leave.
   */
  flushLate(): void {
    if (!this.left || this.lateQueued) {
      return;
    }

    this.lateQueued = true;
    queueMicrotask(() => {
      this.lateQueued = false;

      // A pageshow or an uninstall in between means the page stays or the sender stopped.
      if (this.left) {
        this.flush("pagehide");
      }
    });
  }

  /**
   * Drains pending records synchronously and sends them with a beacon, a keepalive fetch or
   * emergency storage. A hidden document gets a normal flush. Never awaits and never throws,
   * because the caller is an unload listener.
   * @param reason Reason code of the flush.
   */
  flush(reason: ExitReason): void {
    const { config, diagnostics } = this.deps;

    // Runs first, so that the drain below also takes the open metric interval's points.
    diagnostics.guard("pipeline.crashed", "The metric points before the exit flush failed.", () => {
      this.deps.beforeExit?.();
    });

    // hidden fires on every tab switch, and the document keeps running. A normal flush keeps
    // the headers, gzip and the retry, none of which a beacon has. The in-flight batches
    // complete on their own. Taking them here would send the records again under a new id.
    if (reason === "hidden") {
      this.flushAlive();
      return;
    }

    if (config.transport) {
      this.flushCustom(reason, config.transportOnExit);
      return;
    }

    const url = this.endpointUrl();
    if (url === null) {
      return;
    }

    // A hidden flush's keepalive sends can still be in flight, so start from the transport's count.
    // An earlier exit flush's sends aren't in it, so a late flush adds this leave's own sends.
    const inFlight = this.deps.keepaliveInFlight() ?? 0;
    this.keepaliveBytes = inFlight + (this.left ? this.leaveBytes : 0);

    for (const batch of this.deps.drainForExit()) {
      // resolveConfig keeps only a valid absolute metricsEndpoint and tracesEndpoint. A traces
      // batch without tracesEndpoint has no destination.
      const kind = batchKind(batch, config);
      const target = kind === "logs" ? url.href : endpointFor(kind, config);
      if (target) {
        this.flushBatch(batch, reason, new URL(target));
      } else {
        diagnostics.count("record.dropped_no_destination");
      }
    }

    if (this.left) {
      this.leaveBytes = this.keepaliveBytes - inFlight;
    }
  }

  /**
   * Sends one exit batch with a beacon, a keepalive fetch or emergency storage.
   * @param batch Batch to send.
   * @param reason Reason code of the flush.
   * @param url Endpoint of the batch.
   */
  private flushBatch(batch: LogBatch, reason: ExitReason, url: URL): void {
    const { config } = this.deps;

    if (batch.records.length === 0) {
      return;
    }

    const serialized = this.serialize(batch, reason);
    if (!serialized) {
      return;
    }

    // An oversized payload goes to the synchronous localStorage queue, because localStorage
    // is the only storage that accepts a write without an await.
    const bytes = estimateBytes(serialized.body);
    if (bytes > BEACON_LIMIT_BYTES) {
      this.park(batch);
      return;
    }

    // The batch ID and the reason go in query parameters, because a beacon can't set a header and
    // a text/plain fetch with one would need a preflight.
    url.searchParams.set(QUERY_PARAM_BATCH_ID, batch.id);
    url.searchParams.set(QUERY_PARAM_EXIT_REASON, reason);

    const target = url.toString();

    const custom = this.deps.exitHeaders();
    const typedHeaders = (): Headers => {
      const headers = new Headers(custom);
      headers.set(HEADER_CONTENT_TYPE, serialized.contentType);
      headers.set(HEADER_BATCH_ID, batch.id);
      return headers;
    };

    // sendBeacon can't set a header, and an ingest server that needs the authorization header
    // drops a beacon. Send the last headers with a keepalive fetch instead.
    if (custom) {
      this.keepaliveFetch(target, batch, serialized.body, bytes, reason, typedHeaders);
      return;
    }

    // A headers function has no cached result until it has been called once. The server refuses
    // a beacon without the headers, so let the next page load send the batch with them.
    if (config.headers) {
      this.park(batch);
      return;
    }

    // A same-origin request needs no preflight, so it can carry the serializer's content type.
    // A stock OpenTelemetry Collector answers 415 to text/plain and the batch is lost.
    if (this.isSameOrigin(url)) {
      this.keepaliveFetch(target, batch, serialized.body, bytes, reason, typedHeaders);
      return;
    }

    // text/plain and no other header keep the request "simple", so the browser sends no preflight.
    const plain = (): Headers => new Headers({ [HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN });

    // sendBeacon always sends the cookies, whatever `credentials` says. Only an app that asked for
    // cookies gets a beacon, or a session cookie on a parent domain would reach the ingest server.
    const wantsCookies = config.credentials === "include";
    if (!wantsCookies) {
      this.keepaliveFetch(target, batch, serialized.body, bytes, reason, plain);
      return;
    }

    const outcome = this.beacon(target, serialized.body);
    if (outcome === "sent") {
      // Count the beacon, or a later same-origin fetch would go over the budget they share.
      this.keepaliveBytes += bytes;
      return;
    }

    // A refusal means the in-flight budget is full, and nothing retries a send while the document
    // closes. Mark the shared budget as used up, so a later keepalive fetch is parked, not lost.
    if (outcome === "refused") {
      this.keepaliveBytes = BEACON_LIMIT_BYTES;
      this.park(batch);
      return;
    }

    this.keepaliveFetch(target, batch, serialized.body, bytes, reason, plain);
  }

  /**
   * Checks whether the endpoint is on the page's origin, where a request needs no CORS preflight.
   * @param url Endpoint of the batch.
   * @returns False for another origin, for an opaque origin, and when the origin global and
   * location disagree or the host has no location.
   */
  private isSameOrigin(url: URL): boolean {
    if (typeof location === "undefined") {
      return false;
    }

    // Two opaque origins both read "null" but are never the same origin, for example a file:
    // page in Firefox.
    const isOpaque = url.origin === "null";

    // The origin global is "null" in a frame sandboxed without allow-same-origin, while location
    // still shows the URL's origin.
    const matchesGlobal = url.origin === globalThis.origin;

    // A page's script can replace the origin global with `var origin = "..."`, but it can't
    // replace location. Without this check, that page would send JSON to another origin.
    const matchesLocation = url.origin === location.origin;

    return !isOpaque && matchesGlobal && matchesLocation;
  }

  /** Runs a hidden document's normal flush, and reports it if it throws or rejects. */
  private flushAlive(): void {
    const { diagnostics } = this.deps;
    const message = "The flush of the hidden document failed.";

    diagnostics.guard("pipeline.crashed", message, () => {
      void Promise.resolve(this.deps.flushAlive()).catch((error: unknown) => {
        diagnostics.report("pipeline.crashed", message, undefined, error);
      });
    });
  }

  /**
   * Hands the pending records to a custom transport's exit hook, because a closing page can't
   * wait for the async transport. Without a hook, or when the hook refuses the batch, the
   * batch goes to the emergency queue and the next page load sends it.
   * @param reason Reason code of the flush.
   * @param onExit The custom transport's synchronous exit hook.
   */
  private flushCustom(reason: ExitReason, onExit: ExitTransport | undefined): void {
    const { config, diagnostics } = this.deps;

    for (const batch of this.deps.drainForExit()) {
      const serialized = this.serialize(batch, reason);
      if (!serialized) {
        continue;
      }

      const request = toTransportRequest(batch, serialized, batchKind(batch, config));
      const accepted =
        onExit !== undefined &&
        diagnostics.guard("transport.http_error", "The transportOnExit hook threw an error.", () =>
          runAsLibraryRequest(() => onExit(request)),
        ) === true;

      if (!accepted) {
        this.park(batch);
      }
    }
  }

  /**
   * Parks a batch in the localStorage emergency queue for the next page load. With the storage
   * backend "memory" or "none" the app wants nothing kept on the device, so the batch is lost.
   * @param batch Batch that the exit flush can't send.
   */
  private park(batch: LogBatch): void {
    const { config, diagnostics, onLoss } = this.deps;

    const { backend } = config.storage;
    if (backend === "memory" || backend === "none") {
      onLoss?.("not_stored", batch.records, [batch.id]);
      return;
    }

    saveToEmergencyQueue(batch, diagnostics, onLoss);
  }

  /**
   * Serializes the exit batch, and reports a serializer that throws.
   * @param batch Batch to serialize.
   * @param reason Reason code of the flush.
   * @returns The serialized batch, or undefined if the serializer threw.
   */
  private serialize(batch: LogBatch, reason: ExitReason): SerializedBatch | undefined {
    const serialized = serializeBatch(
      this.deps.config,
      batch,
      this.deps.diagnostics,
      `The ${reason} exit flush could not serialize its batch.`,
    );

    if (!serialized) {
      this.deps.onLoss?.("unserializable", batch.records, [batch.id]);
    }

    return serialized;
  }

  /**
   * Parses the configured endpoint URL.
   * @returns URL instance or null if missing or invalid.
   */
  private endpointUrl(): URL | null {
    const { endpoint } = this.deps.config;
    if (!endpoint) {
      return null;
    }

    const url = this.deps.diagnostics.guard(
      "config.invalid",
      `The exit flush cannot use the endpoint ${endpoint}.`,
      () => new URL(endpoint),
    );

    return url ?? null;
  }

  /**
   * Sends the payload as text/plain with navigator.sendBeacon.
   * @param url Target endpoint URL with query parameters.
   * @param body Serialized payload string.
   * @returns The browser's answer.
   */
  private beacon(url: string, body: string): BeaconOutcome {
    const outcome = this.deps.diagnostics.guard<BeaconOutcome>(
      "transport.http_error",
      "The sendBeacon call failed.",
      () => {
        // Call sendBeacon on navigator so that it keeps its receiver. A detached sendBeacon
        // throws when called.
        const nav = (globalThis as BeaconGlobal).navigator;
        if (!nav?.sendBeacon) {
          return "unavailable";
        }

        // Use text/plain to avoid a CORS preflight. During unload a preflight usually doesn't
        // complete, and the browser then drops the beacon without an error.
        const accepted = nav.sendBeacon(url, new Blob([body], { type: CONTENT_TYPE_TEXT_PLAIN }));
        return accepted ? "sent" : "refused";
      },
    );

    // A throw isn't a refusal. It means the method is there but unusable, and the keepalive
    // fetch can still succeed.
    return outcome ?? "unavailable";
  }

  /**
   * Sends the exit POST with fetch and `keepalive: true`. A keepalive request continues
   * after the document closes, whereas the browser cancels a plain fetch at page close.
   * A fetch that fails while the document is alive parks the batch in the emergency queue, and
   * the server drops a second copy by its batch id. A rejection after the close parks nothing.
   * @param url Target endpoint URL.
   * @param batch Batch in the payload.
   * @param body Serialized payload string.
   * @param bytes Size of the body, which flushBatch has measured already.
   * @param reason Reason code of the flush.
   * @param headers Builds the request headers. To another origin without `headers` that is only
   * a text/plain content type. A header value outside ISO-8859-1 makes the Headers constructor
   * throw.
   */
  private keepaliveFetch(
    url: string,
    batch: LogBatch,
    body: string,
    bytes: number,
    reason: ExitReason,
    headers: () => Headers,
  ): void {
    const { config, diagnostics } = this.deps;
    // A rejection only arrives while the document is alive, and the next page load then sends
    // the batch.
    const park = (): void => {
      this.park(batch);
    };

    // The browser rejects a fetch over the budget after the document closes. By then park()
    // doesn't run, and the batch is lost.
    if (this.keepaliveBytes + bytes > BEACON_LIMIT_BYTES) {
      park();
      return;
    }
    this.keepaliveBytes += bytes;

    const started = diagnostics.guard("transport.http_error", "The keepalive fetch failed.", () => {
      // Network capture skips a request that starts in this scope. Its ignoreUrls entry misses
      // an endpoint such as http://LOCALHOST/, because new URL() rewrites the host in lower case.
      void runAsLibraryRequest(() =>
        fetch(url, {
          method: "POST",
          body,
          headers: headers(),
          credentials: config.credentials,
          keepalive: true,
        }),
      ).catch((error: unknown) => {
        diagnostics.report("transport.http_error", "The exit flush failed.", { reason }, error);
        park();
      });
      return true;
    });

    if (started !== true) {
      park();
    }
  }
}
