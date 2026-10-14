// src/transport/exit-flush.ts
//
// This module flushes buffered batches on exit. It uses sendBeacon, a keepalive fetch or
// emergency storage. It runs during unload. No code in it awaits.

import {
  BEACON_LIMIT_BYTES,
  CONTENT_TYPE_TEXT_PLAIN,
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
  /** This callback drains only the buffered records. It does not touch an in-flight batch. */
  drainPending: () => LogBatch | null;
}

/**
 * This class flushes pending telemetry on document unload. It uses sendBeacon, a keepalive
 * fetch or emergency storage.
 */
export class ExitFlush {
  /** This flag is true while the unload listeners are attached. */
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
   * keepalive fetch or emergency storage. It never awaits and never throws. The caller is an
   * unload listener.
   * @param reason Trigger reason code.
   */
  flush(reason: ExitReason): void {
    const { config, diagnostics } = this.deps;

    if (config.transport) {
      this.flushCustom(reason, config.transportOnExit);
      return;
    }

    const url = this.endpointUrl();
    if (url === null) {
      return;
    }

    const batch = this.drain(reason);
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

    this.keepaliveFetch(target, serialized.body, reason);
  }

  /**
   * Gives the pending records to the exit hook of a custom transport. A page that closes cannot
   * wait for the async transport. Without a hook, or when the hook refuses the batch, the batch
   * goes to the emergency queue. The next page load sends it.
   * @param reason Trigger reason code.
   * @param onExit Synchronous exit hook of the custom transport.
   */
  private flushCustom(reason: ExitReason, onExit: ExitTransport | undefined): void {
    const { diagnostics } = this.deps;

    // The page keeps running after a tab switch. The pipeline sends the records later.
    if (reason === "hidden" && !onExit) {
      return;
    }

    const batch = this.drain(reason);
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
   * @param reason Trigger reason code.
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
   * Selects the drain for the reason. `hidden` occurs at each tab switch. The
   * document continues to run after it. A drain of the in-flight batch here sends it again
   * with a new id. The server cannot deduplicate that second send.
   * @param reason Trigger reason code.
   * @returns Combined LogBatch, or null if no records are pending.
   */
  private drain(reason: ExitReason): LogBatch | null {
    return reason === "hidden" ? this.deps.drainPending() : this.deps.drainForExit();
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
   * @param reason Trigger reason code.
   */
  private keepaliveFetch(url: string, body: string, reason: ExitReason): void {
    const { config, diagnostics } = this.deps;

    diagnostics.guard("transport.http_error", "The keepalive fetch fallback failed.", () => {
      void fetch(url, {
        method: "POST",
        body,
        headers: { [HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN },
        credentials: config.credentials,
        keepalive: true,
      }).catch((error: unknown) => {
        diagnostics.report("transport.http_error", "The exit flush failed.", { reason }, error);
      });
    });
  }
}
