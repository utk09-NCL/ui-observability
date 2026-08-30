// src/core/journey.ts
//
// Manages multi-window user journey lifecycles, token encoding, persistence, and expiration.
// Nothing from storage or a token is trusted. Any code on the origin can write
// either.

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
  OPENFIN_OPTIONS_TIMEOUT_MS,
} from "../constants";
import type { JourneyOptions } from "../models/config";
import { newId } from "../utils/identity";
import { unrefTimer } from "../utils/unref";
import type { Diagnostics } from "./diagnostics";

/** User journey workflow context shared across windows and applications. */
export interface Journey {
  /** Unique journey correlation identifier. */
  id: string;
  /** Human-readable journey workflow name. */
  name: string;
  /** Journey start timestamp in epoch milliseconds. */
  startedAt: number;
  /** Optional parent journey identifier when branched from an earlier workflow. */
  parentId?: string;
  /** Context identifier of the document that initiated the journey. */
  ownerContextId: string;
}

/** Structural interface for OpenFin window metadata. */
interface FinLike {
  /** Target OpenFin window or view. */
  me?: {
    /** Resolves initial window creation options including customData. */
    getOptions?: () => Promise<{ customData?: Record<string, unknown> }>;
  };
}

/** Global environment extended with optional OpenFin APIs. */
type OpenFinGlobal = typeof globalThis & { fin?: FinLike };

/**
 * Safely extracts a non-empty string property from an unverified object.
 * @param source Object to read from.
 * @param key Property name.
 * @returns Non-empty string value or undefined.
 */
function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Safely extracts a finite numeric property from an unverified object.
 * @param source Object to read from.
 * @param key Property name.
 * @returns Finite number value or undefined.
 */
function readNumber(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parses and validates raw sessionStorage data into a Journey object.
 * @param value Unverified parsed JSON value.
 * @returns Validated Journey instance or null.
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
 * Parses and validates decoded token payload into a Journey object.
 * @param value Unverified parsed token payload.
 * @returns Validated Journey instance or null.
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
    parentId: undefined,
    ownerContextId: "",
  };
}

/**
 * Encodes journey metadata into a compact, URL-safe base64 string.
 * @param journey Journey instance to serialize.
 * @returns Unpadded base64url encoded token string.
 */
function encodeToken(journey: Journey): string {
  const json = JSON.stringify({
    i: journey.id,
    n: journey.name.slice(0, JOURNEY_TOKEN_NAME_MAX_CHARS),
    s: journey.startedAt,
  });
  // Binary string conversion handles multi-byte UTF-8 characters before btoa. btoa
  // throws above U+00FF, so a name in a non-Latin script fails without it.
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
 * Rejects when a promise has not settled within a deadline. A stalled OpenFin bridge
 * would otherwise leave `bootstrap()` pending, and with it `init()`, so `ready` is
 * never set and records queue in the boot buffer until it evicts.
 * @param work Promise to bound.
 * @param ms Deadline in milliseconds.
 * @returns The promise's value, or a rejection once the deadline passes.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  const deadline = new Promise<never>((_resolve, reject) => {
    // Not cleared on the happy path. The timer is unreferenced, and the rejection
    // it raises later is delivered to a race that has already settled.
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)}ms`));
    }, ms);
    unrefTimer(timer);
  });

  return Promise.race([work, deadline]);
}

/** Manages journey lifecycle, cross-window adoption, storage synchronization, and expiration. */
export class JourneyEngine {
  /** Active journey context, or null if none is in progress. */
  private journey: Journey | null = null;

  /** Active expiration timer handle. */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param options Journey configuration thresholds.
   * @param diagnostics Diagnostics reporter.
   * @param contextId Unique context identifier for this document.
   * @param onLocalChange Callback invoked when journey state changes locally.
   */
  constructor(
    private readonly options: JourneyOptions,
    private readonly diagnostics: Diagnostics,
    private readonly contextId: string,
    private readonly onLocalChange: (journey: Journey | null) => void,
  ) {}

  /** Returns the active journey instance or null. */
  current(): Journey | null {
    return this.journey;
  }

  /**
   * Discovers and adopts initial journey from URL query parameters, sessionStorage, or OpenFin customData.
   * @returns Promise resolving when journey initialization completes.
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
   * Initiates a new journey, replacing any active journey and notifying connected peers.
   * @param name Human-readable workflow name.
   * @param opts Optional parent linkage and pre-assigned identifier.
   * @returns Started Journey instance.
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

  /** Terminates the active journey and broadcasts the change. */
  end(): void {
    if (this.journey === null) {
      return;
    }
    this.setJourney(null);
    this.onLocalChange(null);
  }

  /**
   * Applies journey updates received from external bus peers without echoing
   * broadcasts. Echoing makes two windows ping the change back and forth. A journey
   * matching the one in force is ignored, so an echo cannot restart the timer.
   * @param journey Updated Journey instance or null.
   */
  applyRemote(journey: Journey | null): void {
    const current = this.journey;
    if (journey !== null && current !== null && journey.id === current.id) {
      return;
    }
    this.setJourney(journey);
  }

  /**
   * Serializes the active journey into a compact token for URL or intent transfer.
   * @returns Base64url token string or undefined if no journey is active or size cap is exceeded.
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
   * Validates and adopts a serialized journey token.
   * @param token Base64url journey token.
   * @param source Originating source description for diagnostics.
   * @param broadcast Indicates whether to broadcast adoption to connected bus peers.
   * @returns True if the token was valid, unexpired, and adopted.
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
   * Ends the journey if the terminated context matches the journey owner and endOnOwnerClose is enabled.
   * @param ownerContextId Context identifier of the closed window.
   */
  ownerClosed(ownerContextId: string): void {
    if (!this.options.endOnOwnerClose) {
      return;
    }
    if (this.journey?.ownerContextId === ownerContextId) {
      this.end();
    }
  }

  /** Clears pending expiration timers and releases resources on shutdown. */
  destroy(): void {
    this.clearTimer();
  }

  /**
   * Resumes a persisted journey from raw sessionStorage data.
   * @param raw Serialized JSON string from storage.
   * @returns True if journey was successfully restored.
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
   * Decodes a base64url token into a validated Journey object. Tokens come from URLs
   * anyone can edit. Every step throws on non-token input, so the failure is
   * reported, not raised.
   * @param token Encoded token string.
   * @returns Decoded Journey instance or null on decode error.
   */
  private decodeToken(token: string): Journey | null {
    const decoded = this.diagnostics.guard(
      "config.invalid",
      "decoding a seeded journey token",
      () => {
        const standard = token
          .replace(BASE64URL_DASH_PATTERN, "+")
          .replace(BASE64URL_UNDERSCORE_PATTERN, "/");
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
   * Sets the active journey, updates sessionStorage, and schedules expiration.
   * @param journey Target Journey instance or null.
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

    const remaining = Math.max(this.options.maxAgeMs - (Date.now() - journey.startedAt), 0);
    const timer = setTimeout(() => {
      this.diagnostics.report(
        "journey.expired",
        `journey "${journey.name}" hit maxAgeMs and was ended automatically`,
        { journeyId: journey.id },
      );
      this.journey = null;
      this.expiryTimer = null;
      this.clearStored();
    }, remaining);
    this.expiryTimer = timer;
    unrefTimer(timer);
  }

  /** Removes journey data from sessionStorage. */
  private clearStored(): void {
    this.diagnostics.guard("storage.unavailable", "clearing the persisted journey", () => {
      sessionStorage.removeItem(JOURNEY_STORAGE_KEY);
    });
  }

  /** Cancels any active expiration timer. */
  private clearTimer(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /**
   * Extracts the journey token from the current window location search parameters.
   * @returns Token string or null.
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
   * Reads the journey token from OpenFin window creation customData. Bounded by
   * OPENFIN_OPTIONS_TIMEOUT_MS: a deadline reached here reports openfin.unavailable
   * and yields no token, which is the same outcome as a window created without one.
   * @returns Promise resolving to token string or null.
   */
  private async readOpenFinToken(): Promise<string | null> {
    const me = (globalThis as OpenFinGlobal).fin?.me;
    const getOptions = me?.getOptions;
    if (getOptions === undefined) {
      return null;
    }

    // Uses call to preserve target receiver context on native OpenFin methods. A
    // detached copy throws on invocation.
    const options = await this.diagnostics.guardAsync(
      "openfin.unavailable",
      "reading fin.me.getOptions()",
      () => withDeadline(getOptions.call(me), OPENFIN_OPTIONS_TIMEOUT_MS),
    );
    const token = options?.customData?.[OPENFIN_JOURNEY_CUSTOM_DATA_KEY];
    return typeof token === "string" ? token : null;
  }
}
