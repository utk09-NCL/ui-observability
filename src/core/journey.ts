// src/core/journey.ts
//
// A journey is one piece of work a person is doing, followed across every
// window, view and application it touches. No other identifier spans that: a
// session ends after an idle period, a tab id dies with its tab, a context id
// belongs to one document.
//
// It exists in two forms:
//
//   1. The token, which rides in a query string and in an OpenFin window's
//      customData, the two channels that can seed a document that does not
//      exist yet. A query string has a hard length limit, is truncated by
//      proxies and lands in access logs, so the token carries three fields
//      only: id, name, start time. Deliberately lossy.
//   2. The persisted journey, held whole in sessionStorage. No size pressure,
//      so nothing is dropped. Persisting the lossy form instead would let a
//      reload delete the parent link, and `endOnOwnerClose` with it.
//
// `applyRemote` never calls `onLocalChange`. Without that rule window A
// broadcasts, B applies and re-broadcasts, A applies and re-broadcasts, and two
// windows saturate the bus for as long as both are open.
//
// Nothing out of storage or a token is trusted: any code on the origin can
// write that key, and a token comes from a URL anyone can edit. Both are
// checked field by field.

import {
  BASE64_GROUP_CHARS,
  BASE64_PADDING_PATTERN,
  BASE64_PLUS_PATTERN,
  BASE64_SLASH_PATTERN,
  BASE64URL_DASH_PATTERN,
  BASE64URL_UNDERSCORE_PATTERN,
  JOURNEY_STORAGE_KEY,
  JOURNEY_TOKEN_MAX_CHARS,
  JOURNEY_TOKEN_NAME_MAX_CHARS,
  OPENFIN_JOURNEY_CUSTOM_DATA_KEY,
} from "../constants";
import type { JourneyOptions } from "../models/config";
import { newId } from "../utils/identity";
import type { Diagnostics } from "./diagnostics";

/**
 * One journey, as every context that joins it sees it. The whole form: what is
 * persisted and what the record builder reads. A token carries a subset.
 */
export interface Journey {
  /**
   * Groups records from every window and application that joins this journey.
   * Travels in the token.
   */
  id: string;
  /**
   * What the consumer called it, for whoever reads the logs. Truncated inside a
   * token and nowhere else, so the full name still reaches every record.
   */
  name: string;
  /** Epoch ms. Age is measured from here, so this is what `maxAgeMs` is compared against. */
  startedAt: number;
  /**
   * The journey this one branched from. Never travels in a token, since a chain
   * of parents is the growth a query string cannot absorb; the control plane
   * backfills it.
   */
  parentId?: string;
  /**
   * The context that started the journey. `endOnOwnerClose` keys on it, so a
   * context seeded from elsewhere leaves it empty: its closing must not end a
   * journey it did not start.
   */
  ownerContextId: string;
}

/**
 * The one OpenFin call this module makes, declared structurally because the
 * OpenFin types are not a dependency of this package. Everything is optional:
 * the Core Web adapter exposes `fin` too, with a smaller surface than the
 * desktop runtime, so the chains below are checks rather than decoration.
 */
interface FinLike {
  /** This window or view. */
  me?: {
    /** Resolves the options the window was created with, `customData` among them. */
    getOptions?: () => Promise<{ customData?: Record<string, unknown> }>;
  };
}

/** The global object with the OpenFin runtime's one addition, widened once for this module. */
type OpenFinGlobal = typeof globalThis & { fin?: FinLike };

/**
 * A timer handle as the two host families actually hand one back: a number in a
 * browser, an object in Node.
 */
type TimerHandle = number | { unref?: () => void };

/**
 * Stop a pending expiry timer from holding a Node process open. The timer is
 * scheduled up to `maxAgeMs` out, half an hour by default, and under SSR or a
 * test runner it alone keeps the process alive. A browser's numeric handle has
 * no `unref` and needs none.
 */
function unrefTimer(timer: TimerHandle): void {
  if (typeof timer !== "number") {
    timer.unref?.();
  }
}

/**
 * One string field of a value that is not trusted to have it. `Reflect.get`
 * rather than an index, since indexing asserts a shape onto the value whose
 * shape is in question. Empty counts as absent: every field read here is an
 * identifier or a display name.
 */
function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The numeric half of `readString`. NaN and the infinities are rejected too:
 * the only numbers here are timestamps, and an age computed from NaN is never
 * greater than `maxAgeMs`, so such a journey would never expire.
 */
function readNumber(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A value read back out of sessionStorage, as a journey or not at all. Id, name
 * and start time are required, with nothing sensible to substitute. Owner and
 * parent are optional in the type, so a value missing them is still usable.
 */
function journeyFromStorage(value: unknown): Journey | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const id = readString(value, "id");
  const name = readString(value, "name");
  const startedAt = readNumber(value, "startedAt");
  if (id === undefined || name === undefined || startedAt === undefined) {
    return null;
  }
  return {
    id,
    name,
    startedAt,
    parentId: readString(value, "parentId"),
    ownerContextId: readString(value, "ownerContextId") ?? "",
  };
}

/**
 * The decoded body of a token, as a journey or not at all. The single-letter
 * keys are the token's, short for the reason it has three fields: every
 * character is spent in a query string.
 *
 * A missing start time falls back to now, costing an inaccurate age rather than
 * discarding a journey that is probably real. A missing id or name does not.
 */
function journeyFromTokenPayload(value: unknown): Journey | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const id = readString(value, "i");
  const name = readString(value, "n");
  if (id === undefined || name === undefined) {
    return null;
  }
  return {
    id,
    name,
    startedAt: readNumber(value, "s") ?? Date.now(),
    // Neither of these is carried in a token. The control plane fills them in
    // if it reaches this context.
    parentId: undefined,
    ownerContextId: "",
  };
}

/**
 * A journey as a token: three fields, base64url, no padding. base64url because
 * the result goes into a query string, where `+` means a space and `/` and `=`
 * need percent-encoding, which inflates what the length cap protects.
 */
function encodeToken(journey: Journey): string {
  const json = JSON.stringify({
    i: journey.id,
    n: journey.name.slice(0, JOURNEY_TOKEN_NAME_MAX_CHARS),
    s: journey.startedAt,
  });
  // `btoa` takes one character per byte, so the UTF-8 bytes go into a binary
  // string first. Without it a name in any non-Latin script throws here.
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(BASE64_PLUS_PATTERN, "-")
    .replace(BASE64_SLASH_PATTERN, "_")
    .replace(BASE64_PADDING_PATTERN, "");
}

/**
 * The journey this context is in, and every way it can come to be in one. One
 * instance per runtime, owning the in-memory journey, what is persisted for it
 * and the timer that ends it, so those three cannot disagree.
 */
export class JourneyEngine {
  /** The journey in force, or null when this context is not in one. */
  private journey: Journey | null = null;

  /**
   * Handle of the timer that ends the current journey at `maxAgeMs`. Kept so it
   * can be cancelled: a journey replaced before it expires must not be ended
   * later by its predecessor's timer.
   */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    /** The resolved journey section, by reference, so a later reconfigure reaches this instance. */
    private readonly options: JourneyOptions,
    /** Where unreadable storage, undecodable tokens and expiries are reported. */
    private readonly diagnostics: Diagnostics,
    /** This context's id, stamped on a journey started here so `ownerClosed` recognises its own. */
    private readonly contextId: string,
    /**
     * Called when this context changes the journey, so the bus can tell the
     * others. Never called for a change that arrived from the bus.
     */
    private readonly onLocalChange: (journey: Journey | null) => void,
  ) {}

  /** The journey in force, or null. Read on every record, so it stays a field access. */
  current(): Journey | null {
    return this.journey;
  }

  /**
   * Join the journey this context was seeded with, if any. The order matters: a
   * URL token wins as the most recent thing that happened to this document, a
   * persisted journey means a reload, and OpenFin's customData is read last
   * because it is async and every browser would pay a turn of the event loop
   * for a call that cannot succeed there.
   */
  async bootstrap(): Promise<void> {
    const fromUrl = this.readUrlToken();
    if (fromUrl && this.adopt(fromUrl, "url")) {
      return;
    }

    const fromStorage = this.diagnostics.guard(
      "storage.unavailable",
      "reading the persisted journey",
      () => sessionStorage.getItem(JOURNEY_STORAGE_KEY),
    );
    if (fromStorage && this.restore(fromStorage)) {
      return;
    }

    const fromOpenFin = await this.readOpenFinToken();
    if (fromOpenFin !== null) {
      this.adopt(fromOpenFin, "openfin.customData");
    }
  }

  /**
   * Begin a journey here, replacing whatever this context was in.
   *
   * @param name Shown to whoever reads the logs. Not an identifier, so it need not be unique.
   * @param opts `parent` links the new journey to the one it replaces, so a
   * sub-task reads as part of the task that spawned it. `id` adopts an
   * identifier minted elsewhere, for correlating with an upstream system.
   * @returns The journey that is now in force.
   */
  start(name: string, opts: { parent?: boolean; id?: string } = {}): Journey {
    const journey: Journey = {
      id: opts.id ?? newId(),
      name,
      startedAt: Date.now(),
      parentId: opts.parent ? this.journey?.id : undefined,
      ownerContextId: this.contextId,
    };
    this.setJourney(journey);
    this.onLocalChange(journey);
    return journey;
  }

  /**
   * End the journey here and tell the other contexts. Ending nothing is not an
   * error and says nothing.
   */
  end(): void {
    if (this.journey === null) {
      return;
    }
    this.setJourney(null);
    this.onLocalChange(null);
  }

  /**
   * Take the journey another context is in. Does not call `onLocalChange`,
   * which is what stops two windows ping-ponging one change forever. A journey
   * matching the one in force is ignored, so an echo cannot restart the timer.
   */
  applyRemote(journey: Journey | null): void {
    const current = this.journey;
    if (journey !== null && current !== null && journey.id === current.id) {
      return;
    }
    this.setJourney(journey);
  }

  /**
   * The current journey as a token for a window being opened, or undefined when
   * there is none.
   *
   * The size cap is a tripwire, not validation: three fields and a truncated
   * name cannot reach it, so a token that does carries a caller's own id.
   * Issuing nothing beats issuing a URL a proxy will cut in half.
   */
  getToken(): string | undefined {
    const journey = this.journey;
    if (journey === null) {
      return undefined;
    }
    const token = encodeToken(journey);
    if (token.length > JOURNEY_TOKEN_MAX_CHARS) {
      this.diagnostics.report(
        "journey.token_too_large",
        "journey token exceeded the size cap and was not issued",
        { length: token.length },
      );
      return undefined;
    }
    return token;
  }

  /**
   * Join the journey a token describes, unless it is too old to still be one.
   *
   * @param token The encoded journey, from wherever this context was seeded.
   * @param source Where it came from, reported so a seeding channel producing
   * junk is identifiable from the diagnostics alone.
   * @param broadcast For a journey handed over deliberately, the desktop intent
   * case, where the token reaches one window and the rest of the application
   * has to learn of it. Seeding at boot does not broadcast: every window there
   * gets its own seed, and telling the others would overwrite theirs.
   * @returns Whether the journey was adopted.
   */
  adopt(token: string, source: string, broadcast = false): boolean {
    const decoded = this.decodeToken(token);
    if (decoded === null) {
      return false;
    }
    if (Date.now() - decoded.startedAt > this.options.maxAgeMs) {
      this.diagnostics.report("journey.expired", "discarded a seeded journey older than maxAgeMs", {
        source,
        name: decoded.name,
      });
      return false;
    }

    this.setJourney(decoded);
    this.diagnostics.report("journey.adopted", `adopted journey "${decoded.name}"`, {
      source,
      journeyId: decoded.id,
    });
    if (broadcast) {
      this.onLocalChange(decoded);
    }
    return true;
  }

  /**
   * End the journey when the context that started it goes away. Off by default:
   * a trade ticket's journey ends with the ticket, a research task's outlives
   * the window that opened it.
   *
   * @param ownerContextId The context that closed, as the control plane reports it.
   */
  ownerClosed(ownerContextId: string): void {
    if (!this.options.endOnOwnerClose) {
      return;
    }
    if (this.journey?.ownerContextId === ownerContextId) {
      this.end();
    }
  }

  /**
   * Release the expiry timer. Called on shutdown, since a pending timer
   * outlives the runtime that scheduled it.
   */
  destroy(): void {
    this.clearTimer();
  }

  /**
   * Resume the journey this context persisted before a reload.
   *
   * @param raw What was under the storage key. Anything on the origin can write
   * there, so it is validated rather than believed.
   * @returns Whether a journey was resumed.
   */
  private restore(raw: string): boolean {
    const parsed = this.diagnostics.guard(
      "storage.degraded",
      "parsing the persisted journey",
      () => JSON.parse(raw) as unknown,
    );
    const journey = journeyFromStorage(parsed);
    if (journey === null) {
      return false;
    }

    if (Date.now() - journey.startedAt > this.options.maxAgeMs) {
      this.diagnostics.report(
        "journey.expired",
        "discarded a persisted journey older than maxAgeMs",
        { name: journey.name },
      );
      this.clearStored();
      return false;
    }

    this.setJourney(journey);
    this.diagnostics.report("journey.adopted", `resumed journey "${journey.name}"`, {
      source: "sessionStorage",
      journeyId: journey.id,
    });
    return true;
  }

  /**
   * A token back into a journey, or null when it was not one. Every step throws
   * on input that is not a token, and tokens come from URLs anyone can edit, so
   * the whole decode runs inside a guard. Junk there is a configuration problem
   * worth reporting, not a reason to fail.
   */
  private decodeToken(token: string): Journey | null {
    const decoded = this.diagnostics.guard(
      "config.invalid",
      "decoding a seeded journey token",
      () => {
        const standard = token
          .replace(BASE64URL_DASH_PATTERN, "+")
          .replace(BASE64URL_UNDERSCORE_PATTERN, "/");
        // Padding was dropped to keep the token short, so it is recomputed:
        // `atob` rejects a final group shorter than four characters.
        const missing =
          (BASE64_GROUP_CHARS - (standard.length % BASE64_GROUP_CHARS)) % BASE64_GROUP_CHARS;
        const padding = "=".repeat(missing);
        const bytes = Uint8Array.from(atob(standard + padding), (c) => c.charCodeAt(0));
        return journeyFromTokenPayload(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
      },
    );
    return decoded ?? null;
  }

  /**
   * Put a journey in force, persist it, arm its expiry. The single path by
   * which the journey changes, so none of the three can be updated alone.
   */
  private setJourney(journey: Journey | null): void {
    this.journey = journey;
    this.clearTimer();

    this.diagnostics.guard("storage.unavailable", "persisting the journey", () => {
      if (journey !== null) {
        sessionStorage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify(journey));
      } else {
        sessionStorage.removeItem(JOURNEY_STORAGE_KEY);
      }
    });

    if (journey === null) {
      return;
    }

    // Measured from the journey's start, not from now: one adopted twenty
    // minutes into its thirty expires in ten, and one already past its age
    // expires immediately.
    const remaining = Math.max(this.options.maxAgeMs - (Date.now() - journey.startedAt), 0);
    const timer = setTimeout(() => {
      this.diagnostics.report(
        "journey.expired",
        `journey "${journey.name}" hit maxAgeMs and was ended automatically`,
        { journeyId: journey.id },
      );
      // Cleared but not announced. Every context in the journey shares its
      // `startedAt` and reaches this moment on its own, so a broadcast per
      // window would say what they all know.
      this.journey = null;
      this.expiryTimer = null;
      this.clearStored();
    }, remaining);
    this.expiryTimer = timer;
    unrefTimer(timer);
  }

  /** Forget the persisted journey. Storage that cannot be written is reported, never thrown. */
  private clearStored(): void {
    this.diagnostics.guard("storage.unavailable", "clearing the persisted journey", () => {
      sessionStorage.removeItem(JOURNEY_STORAGE_KEY);
    });
  }

  /**
   * Cancel the expiry timer if one is pending. Compared against null, not
   * tested for truth: a host handing back numeric handles may hand back zero,
   * and a truth test would leave that timer running.
   */
  private clearTimer(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /**
   * The seeding token in this document's URL, if there is one. `location` is
   * absent under SSR, and reading a URL can throw in a sandboxed frame.
   */
  private readUrlToken(): string | null {
    const token = this.diagnostics.guard(
      "config.invalid",
      "reading the journey token from the URL",
      () => {
        if (typeof location === "undefined") {
          return null;
        }
        return new URL(location.href).searchParams.get(this.options.urlParam);
      },
    );
    return token ?? null;
  }

  /**
   * The seeding token in this window's OpenFin options. A window a platform
   * provider creates has no URL of its own to carry one, so `customData` is the
   * seeding channel there.
   */
  private async readOpenFinToken(): Promise<string | null> {
    const me = (globalThis as OpenFinGlobal).fin?.me;
    const getOptions = me?.getOptions;
    if (getOptions === undefined) {
      return null;
    }

    // Called through `call`: on the real runtime this method reads `this`, and
    // a detached copy throws on invocation.
    const options = await this.diagnostics.guardAsync(
      "openfin.unavailable",
      "reading fin.me.getOptions()",
      () => getOptions.call(me),
    );
    const token = options?.customData?.[OPENFIN_JOURNEY_CUSTOM_DATA_KEY];
    return typeof token === "string" ? token : null;
  }
}
