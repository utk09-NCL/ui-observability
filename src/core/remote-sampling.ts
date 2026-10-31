// src/core/remote-sampling.ts
//
// Holds the sampling rules from the ingest server for their TTL. The rules are an overlay.
// The library does not write them into the config. A later configure() and the TTL then stay simple.
// Only the lazy chunks import this class. The main bundle imports the types.

import { LEVEL_ORDER, REMOTE_SAMPLING_VERSION } from "../constants";
import type { ResolvedConfig } from "../models/config";
import type { LogLevel } from "../models/log-record";
import { levelFor, longestPrefix } from "./sampling";

/** Sampling rules from the ingest server, after validation. */
export interface RemoteRules {
  /** Rate when no namespace rate matches. Without it, the config rate applies. */
  defaultRate?: number;
  /** Rate for each namespace prefix. They apply over the config rates. */
  rates: Record<string, number>;
  /** Lowest level that the library sends. It can only lower `minLevel`. */
  minLevel?: LogLevel;
  /** Lowest level for each namespace prefix. It can only lower the level of the config. */
  minLevels?: Record<string, LogLevel>;
}

/** Rules and their TTL, after validation. */
export interface RemoteUpdate {
  /** Validated rules. */
  rules: RemoteRules;
  /** Time that the rules stay in force, in milliseconds. */
  ttlMs: number;
}

/** Rules in the shape of the header. A context sends them to a forwarder over the bus. */
export interface RemoteWire extends RemoteRules {
  /** Rules version. */
  v: typeof REMOTE_SAMPLING_VERSION;
  /** Time that the rules stay in force, in milliseconds. */
  ttlMs: number;
}

/** Slot of the runtime for the overlay. The sender or the bus fills it when the first rules arrive. */
export interface RemoteSlot {
  /** Overlay, or null before the first rules. */
  sampling: RemoteSampling | null;
}

/** Remote sampling rules in force for this context. */
export class RemoteSampling {
  /** Rules in force, or null. */
  private rules: RemoteRules | null = null;

  /** Time that the rules arrived, in epoch milliseconds. */
  private receivedAt = 0;

  /** Time that the rules end, in epoch milliseconds. */
  private until = 0;

  /**
   * @param config Active configuration instance. A reconfigure changes it in place.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /**
   * Puts new rules in force. They replace the rules in force.
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
   * Returns the rules in force.
   * @returns The rules, or null after the TTL or when `sampling.remote` is off.
   */
  current(): RemoteRules | null {
    if (!this.rules) {
      return null;
    }

    const now = Date.now();

    // Drop the rules when remote sampling is off. Turning it on again must not bring them back.
    // Guard against a clock that moves back. The rules then stay longer than their TTL.
    if (!this.config.sampling.remote || now < this.receivedAt || now >= this.until) {
      this.rules = null;
      return null;
    }

    return this.rules;
  }

  /**
   * Returns the lowest level that the library sends for a namespace. A remote prefix level wins
   * over the remote `minLevel`. A remote level applies only when it is lower than the config level.
   * @param namespace Target application namespace.
   * @returns The lower of the remote level and the config level of the namespace.
   */
  minLevelFor(namespace: string): LogLevel {
    const local = levelFor(namespace, this.config);
    const rules = this.current();
    const remote = longestPrefix(namespace, rules?.minLevels ?? {})?.value ?? rules?.minLevel;

    return remote !== undefined && LEVEL_ORDER[remote] < LEVEL_ORDER[local] ? remote : local;
  }

  /**
   * Returns the rules in force in the shape of the header, with the remaining TTL.
   * @returns The rules, or null if no rules are in force.
   */
  wire(): RemoteWire | null {
    const rules = this.current();

    if (!rules) {
      return null;
    }

    return { ...rules, v: REMOTE_SAMPLING_VERSION, ttlMs: this.until - Date.now() };
  }
}
