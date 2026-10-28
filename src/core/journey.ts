// src/core/journey.ts
//
// This module manages the lifecycle of a user journey across windows. It encodes tokens,
// stores the journey and ends it at expiry. Do not trust a value from storage or a token.
// Any code on the origin can write to both.

import {
  BASE64_GROUP_CHARS,
  BASE64_PADDING_PATTERN,
  BASE64_PLUS_PATTERN,
  BASE64_SLASH_PATTERN,
  BASE64URL_DASH_PATTERN,
  BASE64URL_UNDERSCORE_PATTERN,
  JOURNEY_END_ON_OWNER_CLOSE,
  JOURNEY_MAX_AGE_MS,
  JOURNEY_STORAGE_KEY,
  JOURNEY_TOKEN_MAX_CHARS,
  JOURNEY_TOKEN_NAME_MAX_CHARS,
  OPENFIN_JOURNEY_CUSTOM_DATA_KEY,
  JOURNEY_URL_PARAM,
  OPENFIN_OPTIONS_TIMEOUT_MS,
} from "../constants";
import { withDeadline } from "../utils/deadline";
import { BROWSER_STORES, type IdentityStores, newId } from "../utils/identity";
import { unrefTimer } from "../utils/unref";
import type { Diagnostics } from "./diagnostics";

/** Lifetime rules for a journey. A journey is one user task across several contexts. */
export interface JourneyOptions {
  /** Maximum open time of a journey, in milliseconds. After this time, the engine ends it. */
  maxAgeMs: number;
  /** True if the journey ends for all contexts when the owning context closes. */
  endOnOwnerClose: boolean;
  /** Query parameter checked at boot for a seeded journey token. */
  urlParam: string;
}

/** Journey lifetime policy in force. Tests build an engine with shorter values. */
export const JOURNEY_OPTIONS: JourneyOptions = {
  maxAgeMs: JOURNEY_MAX_AGE_MS,
  endOnOwnerClose: JOURNEY_END_ON_OWNER_CLOSE,
  urlParam: JOURNEY_URL_PARAM,
};

/** User journey workflow context shared across windows and applications. */
export interface Journey {
  /** Unique journey correlation identifier. */
  id: string;
  /** Journey workflow name for a person to read. */
  name: string;
  /** Journey start timestamp in epoch milliseconds. */
  startedAt: number;
  /** Optional parent journey ID when the journey branches from an earlier journey. */
  parentId?: string;
  /** Context identifier of the document that started the journey. */
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
 * Reads a non-empty string property from an unverified object.
 * @param source Object to read from.
 * @param key Property name.
 * @returns Non-empty string value or undefined.
 */
function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Reads a finite number property from an unverified object.
 * @param source Object to read from.
 * @param key Property name.
 * @returns Finite number value or undefined.
 */
function readNumber(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parses and validates an unknown value into a Journey object. The value comes from
 * sessionStorage or from a bus message of another realm.
 * @param value Unverified parsed JSON value.
 * @returns Validated Journey instance or null.
 */
export function parseJourney(value: unknown): Journey | null {
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
  // Convert the UTF-8 bytes to a binary string before btoa. btoa throws above U+00FF.
  // Without this step, a name in a non-Latin script fails.
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
   * @param stores Identity stores that hold the journey.
   */
  constructor(
    private readonly options: JourneyOptions,
    private readonly diagnostics: Diagnostics,
    private readonly contextId: string,
    private readonly onLocalChange: (journey: Journey | null) => void,
    private readonly stores: IdentityStores = BROWSER_STORES,
  ) {}

  /** Returns the active journey instance or null. */
  current(): Journey | null {
    return this.journey;
  }

  /**
   * Finds and adopts the initial journey. It checks the URL query, then sessionStorage,
   * then OpenFin customData.
   * @returns Promise that resolves when journey initialization completes.
   */
  async bootstrap(): Promise<void> {
    const fromUrl = this.readUrlToken();
    if (fromUrl && this.adopt(fromUrl, "url")) {
      this.removeUrlToken();
      return;
    }

    const fromStorage = this.diagnostics.guard(
      "storage.unavailable",
      "The library could not read the persisted journey.",
      () => this.stores.session().getItem(JOURNEY_STORAGE_KEY),
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
   * Starts a new journey. It replaces the active journey and tells connected peers.
   * @param name Human-readable workflow name.
   * @param opts Optional parent linkage and pre-assigned identifier.
   * @returns Started Journey instance.
   */
  start(name: string, opts: { parent?: boolean; id?: string } = {}): Journey {
    const journey: Journey = {
      id: opts.id ?? newId(this.diagnostics),
      name,
      startedAt: Date.now(),
      parentId: opts.parent ? this.journey?.id : undefined,
      ownerContextId: this.contextId,
    };
    this.setJourney(journey);
    this.onLocalChange(journey);
    return journey;
  }

  /** Ends the active journey and broadcasts the change. */
  end(): void {
    if (this.journey === null) {
      return;
    }
    this.setJourney(null);
    this.onLocalChange(null);
  }

  /**
   * Applies a journey update from a bus peer. It does not broadcast the update again.
   * An echo makes two windows send the change back and forth without end.
   * It ignores a journey with the same ID as the active journey. Thus an echo cannot
   * restart the timer.
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
   * @returns Base64url token, or undefined when no journey is active or the token exceeds
   * the size limit.
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
        "The journey token is larger than the size limit. The library does not issue it.",
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
   * @param broadcast True to send the adoption to the connected bus peers.
   * @returns True if the token was valid, unexpired, and adopted.
   */
  adopt(token: string, source: string, broadcast = false): boolean {
    const decoded = this.decodeToken(token);
    if (decoded === null) {
      return false;
    }
    if (Date.now() - decoded.startedAt > this.options.maxAgeMs) {
      this.diagnostics.report(
        "journey.expired",
        "The library discarded a seeded journey older than maxAgeMs.",
        {
          source,
          name: decoded.name,
        },
      );
      return false;
    }

    this.setJourney(decoded);
    this.diagnostics.report(
      "journey.adopted",
      `The library adopted the journey "${decoded.name}".`,
      {
        source,
        journeyId: decoded.id,
      },
    );
    if (broadcast) {
      this.onLocalChange(decoded);
    }
    return true;
  }

  /**
   * Ends the journey when endOnOwnerClose is on and the closed context owns the journey.
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
   * @returns True if the engine restored the journey.
   */
  private restore(raw: string): boolean {
    const parsed = this.diagnostics.guard(
      "storage.degraded",
      "The library could not parse the persisted journey.",
      () => JSON.parse(raw) as unknown,
    );
    const journey = parseJourney(parsed);
    if (journey === null) {
      return false;
    }

    if (Date.now() - journey.startedAt > this.options.maxAgeMs) {
      this.diagnostics.report(
        "journey.expired",
        "The library discarded a persisted journey older than maxAgeMs.",
        { name: journey.name },
      );
      this.clearStored();
      return false;
    }

    this.setJourney(journey);
    this.diagnostics.report(
      "journey.adopted",
      `The library resumed the journey "${journey.name}".`,
      {
        source: "sessionStorage",
        journeyId: journey.id,
      },
    );
    return true;
  }

  /**
   * Decodes a base64url token into a validated Journey object. Anyone can edit the URL
   * that holds a token. Each step throws on bad input. The guard reports the failure
   * and does not throw it.
   * @param token Encoded token string.
   * @returns Decoded Journey instance or null on decode error.
   */
  private decodeToken(token: string): Journey | null {
    const decoded = this.diagnostics.guard(
      "config.invalid",
      "The library could not decode a seeded journey token.",
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

    this.diagnostics.guard("storage.unavailable", "The library could not save the journey.", () => {
      if (journey !== null) {
        this.stores.session().setItem(JOURNEY_STORAGE_KEY, JSON.stringify(journey));
      } else {
        this.stores.session().removeItem(JOURNEY_STORAGE_KEY);
      }
    });

    if (journey === null) {
      return;
    }

    const remaining = Math.max(this.options.maxAgeMs - (Date.now() - journey.startedAt), 0);
    const timer = setTimeout(() => {
      this.diagnostics.report(
        "journey.expired",
        `The journey "${journey.name}" reached maxAgeMs. The library ended it.`,
        { journeyId: journey.id },
      );
      this.journey = null;
      this.expiryTimer = null;
      this.clearStored();
    }, remaining);
    this.expiryTimer = timer;
    unrefTimer(timer);
  }

  /** Removes journey data from the session store. */
  private clearStored(): void {
    this.diagnostics.guard(
      "storage.unavailable",
      "The library could not clear the persisted journey.",
      () => {
        this.stores.session().removeItem(JOURNEY_STORAGE_KEY);
      },
    );
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
      "The library could not read the journey token from the URL.",
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
   * Removes the journey token from the address bar after the engine adopts it.
   * If not, a copy or a bookmark of the link starts the same journey in another session.
   */
  private removeUrlToken(): void {
    this.diagnostics.guard(
      "platform.api_blocked",
      "The library could not remove the journey token from the URL.",
      () => {
        const url = new URL(location.href);
        url.searchParams.delete(this.options.urlParam);
        // Keep history.state. A router stores its own state there.
        history.replaceState(history.state, "", url.href);
      },
    );
  }

  /**
   * Reads the journey token from the customData of the OpenFin window options.
   * OPENFIN_OPTIONS_TIMEOUT_MS limits the wait. At the deadline, it reports
   * openfin.unavailable and returns no token. A window without a token gives the same result.
   * @returns Promise that resolves to token string or null.
   */
  private async readOpenFinToken(): Promise<string | null> {
    const me = (globalThis as OpenFinGlobal).fin?.me;
    const getOptions = me?.getOptions;
    if (getOptions === undefined) {
      return null;
    }

    // Use call to keep the receiver of the native OpenFin method. A detached copy
    // throws when called.
    const options = await this.diagnostics.guardAsync(
      "openfin.unavailable",
      "The library could not read fin.me.getOptions().",
      () => withDeadline(getOptions.call(me), OPENFIN_OPTIONS_TIMEOUT_MS),
    );
    const token = options?.customData?.[OPENFIN_JOURNEY_CUSTOM_DATA_KEY];
    return typeof token === "string" ? token : null;
  }
}
