// src/transport/exit-flush.ts
//
// This module flushes buffered batches on exit. It uses sendBeacon, a keepalive fetch or
// emergency storage. It runs during unload. No code in it awaits. A hidden document
// still runs. It gets a normal flush.

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
import type { SerializedBatch } from "../models/serializer";
import { saveToEmergencyQueue } from "../storage/emergency-queue";
import { runAsLibraryRequest } from "../utils/library-request";
import { estimateBytes } from "../utils/sanitize";
import { toTransportRequest } from "./custom-transport";
import { serializeBatch } from "./serializers/select";

/** This type names the lifecycle event or manual action that starts an exit flush. */
export type ExitReason = "hidden" | "pagehide" | "freeze" | "openfin-close" | "shutdown";

/**
 * This type holds the answer of the browser to a beacon. `refused` means that the in-flight
 * budget is full. `unavailable` means that the host has no usable sendBeacon.
 */
type BeaconOutcome = "sent" | "refused" | "unavailable";

/** This interface describes the OpenFin window event API that the flush uses. */
interface FinMeLike {
  on?: (event: string, listener: () => void) => void;
  removeListener?: (event: string, listener: () => void) => void;
}

/** This type adds the optional OpenFin runtime API to globalThis. */
type OpenFinGlobal = typeof globalThis & { fin?: { me?: FinMeLike } };

/** This type reads navigator.sendBeacon without global DOM type assertions. */
interface BeaconGlobal {
  navigator?: { sendBeacon?: (url: string, data: Blob) => boolean };
}

/** This interface lists the dependencies of ExitFlush. */
export interface ExitFlushDeps {
  /** This field holds the active configuration. */
  config: ResolvedConfig;
  /** This field holds the diagnostics reporter. */
  diagnostics: Diagnostics;
  /** This callback drains all buffered and unconfirmed batches into one LogBatch. */
  drainForExit: () => LogBatch | null;
  /**
   * This callback runs a normal flush with headers, gzip and retry. A hidden document uses it.
   * It does not touch an in-flight batch.
   */
  flushAlive: () => void | Promise<void>;
  /**
   * This callback gives the headers that the HTTP transport sent last, or undefined.
   * sendBeacon cannot set a header. With headers, the exit flush uses a keepalive fetch.
   */
  exitHeaders: () => Record<string, string> | undefined;
}

/**
 * This class flushes pending telemetry on document unload. It uses sendBeacon, a keepalive
 * fetch or emergency storage.
 */
export class ExitFlush {
  /** This flag is true while the library listens for the unload events. */
  private installed = false;

  /** This listener flushes on visibilitychange when the document becomes hidden. */
  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      this.flush("hidden");
    }
  };

  /** This listener flushes on the window pagehide event. */
  private readonly onPageHide = (): void => {
    this.flush("pagehide");
  };

  /** This listener flushes on the document freeze event. */
  private readonly onFreeze = (): void => {
    this.flush("freeze");
  };

  /** This listener flushes on the OpenFin close-requested event. */
  private readonly onOpenFinClose = (): void => {
    this.flush("openfin-close");
  };

  /**
   * @param deps Injected configuration, diagnostics, and drain callback.
   */
  constructor(private readonly deps: ExitFlushDeps) {}

  /** This method attaches the unload listeners to the document, the window and OpenFin. */
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

    const me = (globalThis as OpenFinGlobal).fin?.me;
    this.deps.diagnostics.guard(
      "openfin.unavailable",
      "The library could not subscribe to close-requested.",
      () => {
        me?.on?.("close-requested", this.onOpenFinClose);
      },
    );
  }

  /** This method removes all unload listeners and subscriptions. */
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

    const me = (globalThis as OpenFinGlobal).fin?.me;
    this.deps.diagnostics.guard(
      "openfin.unavailable",
      "The library could not unsubscribe from close-requested.",
      () => {
        me?.removeListener?.("close-requested", this.onOpenFinClose);
      },
    );
  }

  /**
   * Drains pending records synchronously. It sends them with a beacon, a
   * keepalive fetch or emergency storage. A hidden document gets a normal flush. It never
   * awaits and never throws. The caller is an unload listener.
   * @param reason Reason code of the flush.
   */
  flush(reason: ExitReason): void {
    const { config, diagnostics } = this.deps;

    // hidden fires at each tab switch. The document keeps running. A normal flush keeps the
    // headers, gzip and the retry. A beacon has none of them. The in-flight batches complete
    // by themselves. A take of them here sends the records again under a new id.
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

    const batch = this.deps.drainForExit();
    if (!batch || batch.records.length === 0) {
      return;
    }

    const serialized = this.serialize(batch, reason);
    if (!serialized) {
      return;
    }

    // Save an oversized payload to the synchronous localStorage queue. localStorage is the
    // only storage that accepts a write without await.
    if (estimateBytes(serialized.body) > BEACON_LIMIT_BYTES) {
      saveToEmergencyQueue(batch, diagnostics);
      return;
    }

    // Send the batch ID and the reason as query parameters. sendBeacon cannot set headers.
    url.searchParams.set(QUERY_PARAM_BATCH_ID, batch.id);
    url.searchParams.set(QUERY_PARAM_EXIT_REASON, reason);

    const target = url.toString();

    // sendBeacon cannot set a header. An ingest server that needs the authorization header
    // drops a beacon. Send the last headers with a keepalive fetch.
    const custom = this.deps.exitHeaders();
    if (custom) {
      this.keepaliveFetch(target, serialized.body, reason, () => {
        const headers = new Headers(custom);
        headers.set(HEADER_CONTENT_TYPE, serialized.contentType);
        headers.set(HEADER_BATCH_ID, batch.id);
        return headers;
      });
      return;
    }

    // A headers function has no cached result until a call gives one. The server refuses a
    // beacon without the headers. The next page load sends the batch with them.
    if (config.headers) {
      saveToEmergencyQueue(batch, diagnostics);
      return;
    }

    const outcome = this.beacon(target, serialized.body);
    if (outcome === "sent") {
      return;
    }

    // A refusal means the in-flight budget is full. A keepalive fetch uses the
    // same budget and fails the same way. The document closes. No code retries the send.
    if (outcome === "refused") {
      saveToEmergencyQueue(batch, diagnostics);
      return;
    }

    const plain = (): Headers => new Headers({ [HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN });
    this.keepaliveFetch(target, serialized.body, reason, plain);
  }

  /** Runs the normal flush of a hidden document. It reports a flush that throws or rejects. */
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
   * Gives the pending records to the exit hook of a custom transport. A page that closes cannot
   * wait for the async transport. Without a hook, or when the hook refuses the batch, the batch
   * goes to the emergency queue. The next page load sends it.
   * @param reason Reason code of the flush.
   * @param onExit Synchronous exit hook of the custom transport.
   */
  private flushCustom(reason: ExitReason, onExit: ExitTransport | undefined): void {
    const { diagnostics } = this.deps;

    const batch = this.deps.drainForExit();
    if (!batch || batch.records.length === 0) {
      return;
    }

    const serialized = this.serialize(batch, reason);
    if (!serialized) {
      return;
    }

    const accepted =
      onExit !== undefined &&
      diagnostics.guard("transport.http_error", "The transportOnExit hook threw an error.", () =>
        runAsLibraryRequest(() => onExit(toTransportRequest(batch, serialized))),
      ) === true;

    if (!accepted) {
      saveToEmergencyQueue(batch, diagnostics);
    }
  }

  /**
   * Serializes the exit batch. It reports a serializer that throws.
   * @param batch Batch to serialize.
   * @param reason Reason code of the flush.
   * @returns The serialized batch, or undefined if the serializer threw.
   */
  private serialize(batch: LogBatch, reason: ExitReason): SerializedBatch | undefined {
    return serializeBatch(
      this.deps.config.serializer,
      batch,
      this.deps.diagnostics,
      `The ${reason} exit flush could not serialize its batch.`,
    );
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
   * @returns The answer of the browser.
   */
  private beacon(url: string, body: string): BeaconOutcome {
    const outcome = this.deps.diagnostics.guard<BeaconOutcome>(
      "transport.http_error",
      "The sendBeacon call failed.",
      () => {
        // Call sendBeacon on navigator to keep its receiver. A detached sendBeacon throws when
        // called.
        const nav = (globalThis as BeaconGlobal).navigator;
        if (!nav?.sendBeacon) {
          return "unavailable";
        }

        // Use text/plain to prevent a CORS preflight during unload. A preflight during unload
        // usually does not complete. The browser then drops the beacon without an error.
        const accepted = nav.sendBeacon(url, new Blob([body], { type: CONTENT_TYPE_TEXT_PLAIN }));
        return accepted ? "sent" : "refused";
      },
    );

    // A throw is not a refusal. The method is present but unusable. The keepalive fetch can
    // still succeed.
    return outcome ?? "unavailable";
  }

  /**
   * Sends a fallback POST with fetch and `keepalive: true`. A keepalive request
   * continues after the document closes. The browser cancels a plain fetch at page close.
   * @param url Target endpoint URL.
   * @param body Serialized payload string.
   * @param reason Reason code of the flush.
   * @param headers Builds the request headers. Without custom headers, only a text/plain
   * content type. A header value outside ISO-8859-1 makes the Headers constructor throw.
   */
  private keepaliveFetch(
    url: string,
    body: string,
    reason: ExitReason,
    headers: () => Headers,
  ): void {
    const { config, diagnostics } = this.deps;

    diagnostics.guard("transport.http_error", "The keepalive fetch failed.", () => {
      void fetch(url, {
        method: "POST",
        body,
        headers: headers(),
        credentials: config.credentials,
        keepalive: true,
      }).catch((error: unknown) => {
        diagnostics.report("transport.http_error", "The exit flush failed.", { reason }, error);
      });
    });
  }
}
