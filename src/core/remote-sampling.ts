// src/core/remote-sampling.ts
//
// Holds the sampling rules from the ingest server for their TTL. The rules are an overlay
// and are never written into the config, which keeps a later configure() and the TTL simple.
// Only the lazy chunks import this class. The main bundle imports just the types.

import { LEVEL_ORDER, REMOTE_SAMPLING_VERSION } from "../constants";
import type { RemoteCaptureFlag, ResolvedConfig } from "../models/config";
import type { LogLevel } from "../models/log-record";
import { levelFor, longestPrefix } from "./sampling";

/** Sampling rules from the ingest server, after validation. */
export interface RemoteRules {
  /** Rate used when no namespace rate matches. Without it, the config rate applies. */
  defaultRate?: number;
  /** Rate per namespace prefix. These apply on top of the config rates. */
  rates: Record<string, number>;
  /** Temporary capture switches. Every context applies its own allowlist. */
  capture?: Partial<Record<RemoteCaptureFlag, boolean>>;
  /** Lowest level the library sends. Can only lower `minLevel`. */
  minLevel?: LogLevel;
  /** Lowest level per namespace prefix. Can only lower the config's level. */
  minLevels?: Record<string, LogLevel>;
}

/** Rules and their TTL, after validation. */
export interface RemoteUpdate {
  /** Validated rules. */
  rules: RemoteRules;
  /** How long the rules stay in effect, in milliseconds. */
  ttlMs: number;
}

/** Rules in the header's shape. A context sends them to a forwarder over the bus. */
export interface RemoteWire extends RemoteRules {
  /** Rules version. */
  v: typeof REMOTE_SAMPLING_VERSION;
  /** How long the rules stay in effect, in milliseconds. */
  ttlMs: number;
}

/** The runtime's overlay slot. The sender or the bus fills it when the first rules arrive. */
export interface RemoteSlot {
  /** Overlay, or null before the first rules. */
  sampling: RemoteSampling | null;
  /** Refreshes captures after a trusted rule update. */
  changed?: () => void;
}

/** The remote sampling rules in effect for this context. */
export class RemoteSampling {
  /** Current rules, or null. */
  private rules: RemoteRules | null = null;

  /** When the rules arrived, in epoch milliseconds. */
  private receivedAt = 0;

  /** When the rules end, in epoch milliseconds. */
  private until = 0;

  /**
   * @param config Active configuration instance. A reconfigure changes it in place.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /**
   * Puts new rules into effect, replacing the current ones.
   * @param update Validated rules and their TTL, or null when the upstream has no rules.
   */
  apply(update: RemoteUpdate | null): void {
    if (!update) {
      this.rules = null;
      return;
    }

    const now = Date.now();

    this.rules = update.rules;
    this.receivedAt = now;
    this.until = now + update.ttlMs;
  }

  /**
   * Returns the current rules.
   * @returns The rules, or null after the TTL or when `sampling.remote` is off.
   */
  current(): RemoteRules | null {
    if (!this.rules) {
      return null;
    }

    const now = Date.now();

    // Drop the rules when remote sampling is off, so turning it on again can't bring them back.
    // Also guard against a clock that moves back, which would keep the rules past their TTL.
    if (!this.config.sampling.remote || now < this.receivedAt || now >= this.until) {
      this.rules = null;
      return null;
    }

    return this.rules;
  }

  /**
   * Returns the lowest level the library sends for a namespace. A remote prefix level wins
   * over the remote `minLevel`, and a remote level applies only when it is lower than the
   * config level.
   * @param namespace Target application namespace.
   * @returns The lower of the remote level and the namespace's config level.
   */
  minLevelFor(namespace: string): LogLevel {
    const local = levelFor(namespace, this.config);
    const rules = this.current();
    const remote = longestPrefix(namespace, rules?.minLevels ?? {})?.value ?? rules?.minLevel;

    return remote !== undefined && LEVEL_ORDER[remote] < LEVEL_ORDER[local] ? remote : local;
  }

  /**
   * Returns the current rules in the header's shape, with the remaining TTL.
   * @returns The rules, or null if none are in effect.
   */
  wire(): RemoteWire | null {
    const rules = this.current();

    if (!rules) {
      return null;
    }

    return { ...rules, v: REMOTE_SAMPLING_VERSION, ttlMs: this.until - Date.now() };
  }
}
