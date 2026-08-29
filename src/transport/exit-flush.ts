// src/transport/exit-flush.ts
//
// The last delivery attempt a document gets. Everything here is synchronous: an
// unloading document does not reliably run microtasks, and an IndexedDB write
// never completes. What is too big to beacon goes to the emergency queue.

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

/** What triggered a flush. Reaches the server as a query parameter. */
export type ExitReason = "hidden" | "pagehide" | "freeze" | "openfin-close" | "shutdown";

/**
 * The OpenFin listener calls this module makes, declared structurally so no
 * OpenFin types are required.
 */
interface FinMeLike {
  on?: (event: string, listener: () => void) => void;
  removeListener?: (event: string, listener: () => void) => void;
}

/** The global object with the OpenFin runtime's one addition, widened once for this module. */
type OpenFinGlobal = typeof globalThis & { fin?: { me?: FinMeLike } };

/**
 * `sendBeacon` as this module calls it. A separate type rather than a member of
 * `OpenFinGlobal`: intersecting with `typeof globalThis` collapses an optional
 * `navigator` back to the DOM's non-nullish one, and both guards below then
 * read as dead code. A worker has neither.
 */
interface BeaconGlobal {
  navigator?: { sendBeacon?: (url: string, data: Blob) => boolean };
}

/** What the flush needs from the rest of the library. */
export interface ExitFlushDeps {
  /** The live config object, so a reconfigure reaches this instance. */
  config: ResolvedConfig;
  /** Where a refused beacon and a serializer that threw are reported. */
  diagnostics: Diagnostics;
  /**
   * Everything not yet sent, cleared as it is handed over. Emptying the buffer
   * is the whole guard against a double send: a pagehide arriving straight
   * after a visibilitychange finds nothing. An id set could not do the job,
   * since every drain mints a new batch id.
   */
  drainPending: () => LogBatch | null;
}

/** Delivers what is buffered when the document may never run again. */
export class ExitFlush {
  /** True between `install()` and `uninstall()`. What `uninstall` checks before releasing anything. */
  private installed = false;

  /**
   * Hidden means this document may never run again, so flush. It does not mean
   * destroyed: a hidden OpenFin window is still alive and may be shown again,
   * so nothing is torn down here.
   */
  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.flush("hidden");
    }
  };

  private readonly onPageHide = () => {
    this.flush("pagehide");
  };

  private readonly onFreeze = () => {
    this.flush("freeze");
  };

  private readonly onOpenFinClose = () => {
    this.flush("openfin-close");
  };

  /** @param deps Configuration, diagnostics, and the buffer to drain. */
  constructor(private readonly deps: ExitFlushDeps) {}

  /** Subscribe to every signal that this document may not run again. */
  install(): void {
    // Undeclared outside a browser and a worker, so `typeof` rather than a
    // property read.
    if (this.installed || typeof addEventListener === "undefined") {
      return;
    }
    this.installed = true;

    // `document?.` is not enough. In a worker `document` is an undeclared
    // binding, so evaluating it at all throws a ReferenceError; optional
    // chaining guards null and undefined values, never undeclared identifiers.
    // Reachable, because a worker whose handshake fails promotes to sender.
    if (typeof document !== "undefined") {
      // Both fire at the Document and neither bubbles, so a listener on the
      // window never sees them.
      document.addEventListener("visibilitychange", this.onVisibility);
      document.addEventListener("freeze", this.onFreeze);
    }

    // pagehide fires at the Window.
    addEventListener("pagehide", this.onPageHide);

    // OpenFin can close a window without a normal unload sequence.
    const me = (globalThis as OpenFinGlobal).fin?.me;
    this.deps.diagnostics.guard("openfin.unavailable", "subscribing to close-requested", () => {
      me?.on?.("close-requested", this.onOpenFinClose);
    });
  }

  /** Release every subscription. Explicit shutdown only; `hidden` never reaches this. */
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
   * Deliver what is buffered. Nothing here awaits, and nothing here throws: the
   * caller is an unload handler and there is nothing left to catch anything.
   *
   * @param reason What triggered this flush.
   */
  flush(reason: ExitReason): void {
    const { diagnostics } = this.deps;

    // Checked before the drain: with nowhere to send them, emptying the buffer
    // would only lose the records sooner.
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

    // Over the beacon budget, and there is no time left for a normal request.
    // localStorage is the only synchronous store, so it is the only one that
    // works here. Recovered at the next startup.
    if (estimateBytes(serialized.body) > BEACON_LIMIT_BYTES) {
      saveToEmergencyQueue(batch, diagnostics);
      return;
    }

    // The batch id travels in the query string because `sendBeacon` cannot set
    // headers. The server reads it from either place.
    url.searchParams.set(QUERY_PARAM_BATCH_ID, batch.id);
    url.searchParams.set(QUERY_PARAM_EXIT_REASON, reason);

    const target = url.toString();
    if (this.beacon(target, serialized.body)) {
      return;
    }

    this.keepaliveFetch(target, serialized.body, reason);
  }

  /**
   * The configured endpoint as a URL, or null when there is nothing usable.
   * `resolveConfig` has already reported both cases, so neither is reported
   * again per flush.
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
   * Queue the payload with the browser, which then owns delivery and outlives
   * the document. Tried first for exactly that reason.
   *
   * @returns Whether the browser took it. False means the shared budget is
   * spent, or this host has no `sendBeacon`.
   */
  private beacon(url: string, body: string): boolean {
    const sent = this.deps.diagnostics.guard("transport.http_error", "sendBeacon", () => {
      // Called on the navigator, never through a local copy: a detached
      // `sendBeacon` has no receiver and throws on invocation.
      const nav = (globalThis as BeaconGlobal).navigator;
      if (!nav?.sendBeacon) {
        return false;
      }

      // text/plain is CORS-safelisted, so this is a simple request and no
      // preflight is started. A preflight during unload frequently never
      // completes, and the beacon is then dropped silently.
      return nav.sendBeacon(url, new Blob([body], { type: CONTENT_TYPE_TEXT_PLAIN }));
    });

    return sent === true;
  }

  /**
   * The fallback for a refused beacon. `keepalive` lets the request outlive the
   * document, at the cost of drawing on the same 64 KiB pool. It carries none
   * of the transport's headers: any of them would force a preflight, which is
   * exactly what the beacon path avoids.
   *
   * @param url The endpoint, batch id and reason already attached.
   * @param body The serialized batch.
   * @param reason Reported with a failure, since which signal fired decides how
   * much time the request had.
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
