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
  flushAlive: () => void | Promise<void>;
  /**
   * Returns the headers that the HTTP transport sent last, or undefined. sendBeacon can't set
   * a header, so when there are headers the exit flush uses a keepalive fetch.
   */
  exitHeaders: () => Record<string, string> | undefined;
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

  /** Bytes used by the current exit flush's keepalive fetches. All batches share one budget. */
  private keepaliveBytes = 0;

  /** Flushes on visibilitychange when the document becomes hidden. */
  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      this.flush("hidden");
    }
  };

  /** Flushes on the window's pagehide event. */
  private readonly onPageHide = (): void => {
    this.flush("pagehide");
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

    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
      document.removeEventListener("freeze", this.onFreeze);
    }

    removeEventListener("pagehide", this.onPageHide);

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

    // An earlier flush's fetches are complete or lost by now, so they don't use this budget.
    this.keepaliveBytes = 0;

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
    if (estimateBytes(serialized.body) > BEACON_LIMIT_BYTES) {
      this.park(batch);
      return;
    }

    // The batch ID and the reason go in query parameters, because sendBeacon can't set headers.
    url.searchParams.set(QUERY_PARAM_BATCH_ID, batch.id);
    url.searchParams.set(QUERY_PARAM_EXIT_REASON, reason);

    const target = url.toString();

    // sendBeacon can't set a header, and an ingest server that needs the authorization header
    // drops a beacon. Send the last headers with a keepalive fetch instead.
    const custom = this.deps.exitHeaders();
    if (custom) {
      this.keepaliveFetch(target, batch, serialized.body, reason, () => {
        const headers = new Headers(custom);
        headers.set(HEADER_CONTENT_TYPE, serialized.contentType);
        headers.set(HEADER_BATCH_ID, batch.id);
        return headers;
      });
      return;
    }

    // A headers function has no cached result until it has been called once. The server refuses
    // a beacon without the headers, so let the next page load send the batch with them.
    if (config.headers) {
      this.park(batch);
      return;
    }

    const outcome = this.beacon(target, serialized.body);
    if (outcome === "sent") {
      return;
    }

    // A refusal means the in-flight budget is full. A keepalive fetch uses the same budget and
    // fails the same way, and with the document closing nothing would retry the send.
    if (outcome === "refused") {
      this.park(batch);
      return;
    }

    const plain = (): Headers => new Headers({ [HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN });
    this.keepaliveFetch(target, batch, serialized.body, reason, plain);
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
   * Parks a batch in the localStorage emergency queue for the next page load. With storage
   * "memory" or "none" the app wants nothing kept on the device, so the batch is lost.
   * @param batch Batch that the exit flush can't send.
   */
  private park(batch: LogBatch): void {
    const { config, diagnostics, onLoss } = this.deps;

    if (config.storage === "memory" || config.storage === "none") {
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
   * Sends a fallback POST with fetch and `keepalive: true`. A keepalive request continues
   * after the document closes, whereas the browser cancels a plain fetch at page close.
   * A failed fetch parks the batch in the emergency queue, and the server drops a second copy
   * by its batch id.
   * @param url Target endpoint URL.
   * @param batch Batch in the payload.
   * @param body Serialized payload string.
   * @param reason Reason code of the flush.
   * @param headers Builds the request headers. Without custom headers that is only a text/plain
   * content type. A header value outside ISO-8859-1 makes the Headers constructor throw.
   */
  private keepaliveFetch(
    url: string,
    batch: LogBatch,
    body: string,
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
    const bytes = estimateBytes(body);
    if (this.keepaliveBytes + bytes > BEACON_LIMIT_BYTES) {
      park();
      return;
    }
    this.keepaliveBytes += bytes;

    const started = diagnostics.guard("transport.http_error", "The keepalive fetch failed.", () => {
      void fetch(url, {
        method: "POST",
        body,
        headers: headers(),
        credentials: config.credentials,
        keepalive: true,
      }).catch((error: unknown) => {
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
