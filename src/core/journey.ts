// src/core/journey.ts
//
// A journey is one piece of work a person is doing, followed across every
// window, view and application it touches. None of the other identifiers can do
// that: a session ends after an idle period, a tab id dies with its tab, and a
// context id belongs to one document. A journey outlives all three, because
// "amend this order" starts in one window, opens a second, and finishes in a
// third.
//
// It therefore exists in two forms, and the difference between them is the
// whole design.
//
//   1. The token. It rides in a query string and in an OpenFin window's
//      customData, which are the two channels that can seed a document that
//      does not exist yet. A query string has a hard length limit, is truncated
//      by proxies and is copied into every access log on the way, so the token
//      carries only the three fields that cannot be recovered any other way:
//      the id, the name and the start time. It is deliberately lossy.
//   2. The persisted journey, held whole in sessionStorage. There is no size
//      pressure there, so nothing is dropped. Persisting the lossy form instead
//      would mean a reload quietly deleted the parent link, and `endOnOwnerClose`
//      could never be honoured again afterwards.
//
// The rule that keeps the control plane quiet is that `applyRemote` never calls
// `onLocalChange`. Without it, window A broadcasts, window B applies and
// re-broadcasts, A applies and re-broadcasts, and two windows saturate the bus
// between them for as long as they are both open.
//
// Nothing that comes back out of storage or out of a token is trusted. Any code
// on the origin can write that storage key, and a token arrives from a URL that
// anyone can edit, so both are checked field by field rather than asserted into
// shape.

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
 * One journey, as every context that joins it sees it.
 *
 * This is the whole form, which is what gets persisted and what the record
 * builder reads. The token carries a subset of it.
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
   * The journey this one branched from, where a caller asked for that.
   *
   * Never travels in a token, because a chain of parents is exactly the kind of
   * growth a query string cannot absorb. The control plane backfills it.
   */
  parentId?: string;
  /**
   * The context id that started the journey.
   *
   * `endOnOwnerClose` keys on this, so a journey seeded into a context from
   * elsewhere leaves it empty: that context did not start the journey and its
   * closing must not end one.
   */
  ownerContextId: string;
}

/**
 * The one OpenFin call this module makes, declared structurally because the
 * OpenFin types are deliberately not a dependency of this package.
 *
 * Everything is optional because `fin` is exposed by the Core Web adapter as
 * well as by the desktop runtime, and the two do not offer the same surface.
 * That optionality is what makes the chains below necessary rather than
 * defensive.
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
 * Stop a pending expiry timer from holding a Node process open.
 *
 * A journey's timer is scheduled up to `maxAgeMs` out, which is half an hour by
 * default. Under server-side rendering and in a test runner that timer alone
 * keeps the process alive until it fires. A browser's numeric handle has no
 * `unref` and needs none, so both shapes are handled rather than assumed.
 */
function unrefTimer(timer: TimerHandle): void {
  if (typeof timer !== "number") {
    timer.unref?.();
  }
}

/**
 * One string field of a value that is not trusted to have it.
 *
 * `Reflect.get` rather than an index, because indexing means asserting a shape
 * onto the very value whose shape is in question. An empty string counts as
 * absent: every field read through here is an identifier or a display name, and
 * an empty one carries no more information than a missing one.
 */
function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The numeric half of `readString`.
 *
 * NaN and the infinities are rejected along with the wrong types, since the only
 * numbers here are timestamps and a non-finite one poisons every comparison it
 * reaches: an age computed from NaN is never greater than `maxAgeMs`, so a
 * journey carrying one would never expire.
 */
function readNumber(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A value read back out of sessionStorage, as a journey or not at all.
 *
 * The id, the name and the start time are required, because each one is load
 * bearing and there is nothing sensible to substitute. The owner and the parent
 * are optional in the type, so a value missing them is still a usable journey.
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
 * The decoded body of a token, as a journey or not at all.
 *
 * The single-letter keys are the token's, and they are short for the same
 * reason the token has three fields: every character is spent in a query
 * string. A start time that is missing or not a number falls back to now, which
 * costs an inaccurate age rather than discarding a journey that is probably
 * real; an id or a name that is missing has no such fallback.
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
 * A journey as a token: three fields, base64url, no padding.
 *
 * base64url rather than base64 because the result goes into a query string,
 * where `+` means a space and `/` and `=` have to be percent-encoded. Encoding
 * them would inflate the very thing the length cap is protecting.
 */
function encodeToken(journey: Journey): string {
  const json = JSON.stringify({
    i: journey.id,
    n: journey.name.slice(0, JOURNEY_TOKEN_NAME_MAX_CHARS),
    s: journey.startedAt,
  });
  // `btoa` takes one character per byte, so the UTF-8 bytes are walked into a
  // binary string first. A journey name in any non-Latin script otherwise
  // throws here rather than encoding.
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
 * The journey this context is in, and every way it can come to be in one.
 *
 * One instance per runtime. It owns the in-memory journey, what is persisted
 * for it, and the timer that ends it, so those three cannot disagree.
 */
export class JourneyEngine {
  /** The journey in force, or null when this context is not in one. */
  private journey: Journey | null = null;

  /**
   * Handle of the timer that ends the current journey at `maxAgeMs`.
   *
   * Kept so that it can be cancelled. A journey replaced before it expires must
   * not be ended later by the timer its predecessor started, and that timer is
   * unreachable once the handle is gone.
   */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    /**
     * The resolved journey section. Held by reference, which is what lets a
     * later reconfigure reach an instance built before it.
     */
    private readonly options: JourneyOptions,
    /**
     * Where storage that cannot be read, tokens that cannot be decoded and
     * journeys that expire are reported.
     */
    private readonly diagnostics: Diagnostics,
    /**
     * This context's id, stamped on a journey started here so `ownerClosed` can
     * recognise its own.
     */
    private readonly contextId: string,
    /**
     * Called when the journey changes because of something this context did, so
     * the bus can tell the others. Deliberately not called for a change that
     * arrived from the bus.
     */
    private readonly onLocalChange: (journey: Journey | null) => void,
  ) {}

  /** The journey in force, or null. Read on every record, so it stays a field access. */
  current(): Journey | null {
    return this.journey;
  }

  /**
   * Join the journey this context was seeded with, if it was seeded with one.
   *
   * The order is the point. A token in the URL wins, because it is the most
   * recent thing that happened to this document: someone followed a link into
   * it. A persisted journey comes next, since it means this document is a
   * reload of one already in a journey. OpenFin's customData is read last
   * because reading it is asynchronous, and putting it first would make every
   * browser pay a turn of the event loop for a call that cannot succeed there.
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
   * @param opts `parent` links the new journey to the one being replaced, which
   * is what makes a sub-task legible as part of the task that spawned it.
   * `id` adopts an identifier minted elsewhere, for a caller correlating with a
   * system upstream of this one.
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
   * Take the journey another context is in.
   *
   * Does not call `onLocalChange`, and that is what stops two windows
   * ping-ponging one change between them forever. A journey that arrives
   * already matching the one in force is ignored outright, so an echo does not
   * restart the expiry timer.
   */
  applyRemote(journey: Journey | null): void {
    const current = this.journey;
    if (journey !== null && current !== null && journey.id === current.id) {
      return;
    }
    this.setJourney(journey);
  }

  /**
   * The current journey as a token to hand to a window being opened, or
   * undefined when there is nothing to hand over.
   *
   * The size cap is a tripwire on the query-string budget rather than input
   * validation: three fields and a truncated name cannot reach it, so a token
   * that does is one whose id came from a caller rather than from here.
   * Issuing nothing beats issuing a URL that a proxy will cut in half.
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
   * @param source Where it came from, reported so that a seeding channel which
   * has started producing junk can be identified from the diagnostics alone.
   * @param broadcast For a journey handed over deliberately, which is the
   * desktop intent case: the token reaches one window and the rest of the
   * receiving application has to learn about it too. Seeding at boot does not
   * broadcast, because every window in that flow gets its own seed and telling
   * the others would overwrite theirs.
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
   * End the journey when the context that started it goes away.
   *
   * Off by default. Whether a journey outlives its opener is a product
   * question: a trade ticket's journey should end with the ticket, while a
   * research task's should survive the window that started it.
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
   * A token back into a journey, or null when it was not one.
   *
   * Every step of the decode can throw on input that is not a token, and a
   * token arrives from a URL that anyone can edit, so the whole thing runs
   * inside a guard. Junk in the seeding parameter is a configuration problem
   * worth seeing, not a reason to fail.
   */
  private decodeToken(token: string): Journey | null {
    const decoded = this.diagnostics.guard(
      "config.invalid",
      "decoding a seeded journey token",
      () => {
        const standard = token
          .replace(BASE64URL_DASH_PATTERN, "+")
          .replace(BASE64URL_UNDERSCORE_PATTERN, "/");
        // The padding was dropped to keep the token short, so it is recomputed
        // here: base64 spends four characters on every three bytes, and `atob`
        // rejects a final group shorter than four.
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
   * Put a journey in force, persist it, and arm its expiry. The single path by
   * which the journey changes, so nothing can update one of those three and
   * forget the others.
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

    // Measured from when the journey started, not from now, so a journey
    // adopted after twenty of its thirty minutes expires ten minutes from here
    // rather than thirty. One already past its age expires immediately.
    const remaining = Math.max(this.options.maxAgeMs - (Date.now() - journey.startedAt), 0);
    const timer = setTimeout(() => {
      this.diagnostics.report(
        "journey.expired",
        `journey "${journey.name}" hit maxAgeMs and was ended automatically`,
        { journeyId: journey.id },
      );
      // Cleared in memory and in storage, but not announced. Every context in
      // this journey started from the same `startedAt` and so reaches this
      // moment on its own, and an announcement would be one broadcast per
      // window saying what they all already know.
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
   * Cancel the expiry timer if one is pending.
   *
   * Compared against null rather than tested for truth, because a host that
   * hands back a numeric handle is free to hand back zero, and a truth test
   * would leave that one timer running.
   */
  private clearTimer(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /**
   * The seeding token in this document's URL, if there is one.
   *
   * `location` is absent under server-side rendering, and reading a URL can
   * throw in a sandboxed frame, so neither is assumed.
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
   * The seeding token in this window's OpenFin options, if this is an OpenFin
   * window and it was given one.
   *
   * A window a platform provider creates has no URL of its own to carry a
   * token, so `customData` is the seeding channel there.
   */
  private async readOpenFinToken(): Promise<string | null> {
    const me = (globalThis as OpenFinGlobal).fin?.me;
    const getOptions = me?.getOptions;
    if (getOptions === undefined) {
      return null;
    }

    // Called through `call` rather than as a bare reference: on the real
    // runtime this is a method that reads `this`, and a detached copy of it
    // throws on invocation.
    const options = await this.diagnostics.guardAsync(
      "openfin.unavailable",
      "reading fin.me.getOptions()",
      () => getOptions.call(me),
    );
    const token = options?.customData?.[OPENFIN_JOURNEY_CUSTOM_DATA_KEY];
    return typeof token === "string" ? token : null;
  }
}
