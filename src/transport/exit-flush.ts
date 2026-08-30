// src/transport/exit-flush.ts
//
// Synchronous exit-flush handler delivering buffered batches via sendBeacon, keepalive fetch, or emergency storage.
// Runs during unload. Nothing awaits.

import {
  BEACON_LIMIT_BYTES,
  CONTENT_TYPE_TEXT_PLAIN,
  HEADER_CONTENT_TYPE,
  QUERY_PARAM_BATCH_ID,
  QUERY_PARAM_EXIT_REASON,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { LogBatch } from "../models/batch";
import type { ResolvedConfig } from "../models/config";
import { saveToEmergencyQueue } from "../storage/emergency-queue";
import { estimateBytes } from "../utils/sanitize";

/** Document lifecycle event or manual action that triggered an exit flush. */
export type ExitReason = "hidden" | "pagehide" | "freeze" | "openfin-close" | "shutdown";

/** Structural interface for OpenFin window event subscription. */
interface FinMeLike {
  on?: (event: string, listener: () => void) => void;
  removeListener?: (event: string, listener: () => void) => void;
}

/** Global environment extended with optional OpenFin runtime APIs. */
type OpenFinGlobal = typeof globalThis & { fin?: { me?: FinMeLike } };

/** Structural type for inspecting navigator.sendBeacon without restoring global DOM assertions. */
interface BeaconGlobal {
  navigator?: { sendBeacon?: (url: string, data: Blob) => boolean };
}

/** Injected dependencies required by ExitFlush. */
export interface ExitFlushDeps {
  /** Active configuration instance. */
  config: ResolvedConfig;
  /** Diagnostics reporter instance. */
  diagnostics: Diagnostics;
  /** Callback draining all pending buffered and unconfirmed batches into a single LogBatch. */
  drainPending: () => LogBatch | null;
}

/** Flushes pending telemetry on document unload using sendBeacon, keepalive fetch, or emergency storage. */
export class ExitFlush {
  /** Indicates whether unload listeners are currently active. */
  private installed = false;

  /** Handles visibilitychange events when the document becomes hidden. */
  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      this.flush("hidden");
    }
  };

  /** Handles window pagehide events. */
  private readonly onPageHide = (): void => {
    this.flush("pagehide");
  };

  /** Handles document freeze events. */
  private readonly onFreeze = (): void => {
    this.flush("freeze");
  };

  /** Handles OpenFin close-requested events. */
  private readonly onOpenFinClose = (): void => {
    this.flush("openfin-close");
  };

  /**
   * @param deps Injected configuration, diagnostics, and drain callback.
   */
  constructor(private readonly deps: ExitFlushDeps) {}

  /** Attaches unload listeners across document, window, and OpenFin environments. */
  install(): void {
    if (this.installed || typeof addEventListener === "undefined") {
      return;
    }
    this.installed = true;

    if (typeof document !== "undefined") {
      // visibilitychange and freeze target the document; pagehide targets window.
      document.addEventListener("visibilitychange", this.onVisibility);
      document.addEventListener("freeze", this.onFreeze);
    }

    addEventListener("pagehide", this.onPageHide);

    const me = (globalThis as OpenFinGlobal).fin?.me;
    this.deps.diagnostics.guard("openfin.unavailable", "subscribing to close-requested", () => {
      me?.on?.("close-requested", this.onOpenFinClose);
    });
  }

  /** Removes all registered unload listeners and subscriptions. */
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
    this.deps.diagnostics.guard("openfin.unavailable", "releasing close-requested", () => {
      me?.removeListener?.("close-requested", this.onOpenFinClose);
    });
  }

  /**
   * Synchronously drains pending records and transmits via beacon, keepalive, or
   * emergency storage. Never awaits and never throws. The caller is an unload
   * listener.
   * @param reason Trigger reason code.
   */
  flush(reason: ExitReason): void {
    const { diagnostics } = this.deps;

    const url = this.endpointUrl();
    if (url === null) {
      return;
    }

    const batch = this.deps.drainPending();
    if (!batch || batch.records.length === 0) {
      return;
    }

    const serialized = diagnostics.guard(
      "transport.serialize_failed",
      `the ${reason} exit flush could not serialize its batch`,
      () => this.deps.config.serializer.serialize(batch.records),
    );
    if (!serialized) {
      return;
    }

    // Parks oversized payloads in synchronous localStorage queue. localStorage is
    // the only storage writable without awaiting.
    if (estimateBytes(serialized.body) > BEACON_LIMIT_BYTES) {
      saveToEmergencyQueue(batch, diagnostics);
      return;
    }

    // Passes batch ID and reason via query parameters. sendBeacon cannot set
    // headers.
    url.searchParams.set(QUERY_PARAM_BATCH_ID, batch.id);
    url.searchParams.set(QUERY_PARAM_EXIT_REASON, reason);

    const target = url.toString();
    if (this.beacon(target, serialized.body)) {
      return;
    }

    this.keepaliveFetch(target, serialized.body, reason);
  }

  /**
   * Resolves and parses the destination endpoint URL.
   * @returns URL instance or null if missing or invalid.
   */
  private endpointUrl(): URL | null {
    const { endpoint } = this.deps.config;
    if (!endpoint) {
      return null;
    }

    const url = this.deps.diagnostics.guard(
      "config.invalid",
      `the exit flush cannot use endpoint ${endpoint}`,
      () => new URL(endpoint),
    );

    return url ?? null;
  }

  /**
   * Attempts transmission via navigator.sendBeacon with text/plain payload.
   * @param url Target endpoint URL with query parameters.
   * @param body Serialized payload string.
   * @returns True if the beacon was accepted by the browser.
   */
  private beacon(url: string, body: string): boolean {
    const sent = this.deps.diagnostics.guard("transport.http_error", "sendBeacon", () => {
      // Invokes sendBeacon directly on navigator to preserve receiver context. A
      // detached sendBeacon throws on invocation.
      const nav = (globalThis as BeaconGlobal).navigator;
      if (!nav?.sendBeacon) {
        return false;
      }

      // Uses text/plain to avoid CORS preflights during document unload. A preflight
      // started during unload rarely completes, dropping the beacon silently.
      return nav.sendBeacon(url, new Blob([body], { type: CONTENT_TYPE_TEXT_PLAIN }));
    });

    return sent === true;
  }

  /**
   * Fallback POST delivery using fetch with keepalive: true. keepalive outlives the
   * document. A plain fetch is cancelled as the page goes.
   * @param url Target endpoint URL.
   * @param body Serialized payload string.
   * @param reason Trigger reason code.
   */
  private keepaliveFetch(url: string, body: string, reason: ExitReason): void {
    const { config, diagnostics } = this.deps;

    diagnostics.guard("transport.http_error", "the keepalive fetch fallback", () => {
      void fetch(url, {
        method: "POST",
        body,
        headers: { [HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN },
        credentials: config.credentials,
        keepalive: true,
      }).catch((error: unknown) => {
        diagnostics.report("transport.http_error", "the exit flush failed", { reason }, error);
      });
    });
  }
}
