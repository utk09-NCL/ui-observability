// src/bus/bus.ts
//
// Manages cross-realm bus role resolution, message routing, and boot buffering.

import type { Diagnostics } from "../core/diagnostics";
import type { Journey } from "../core/journey";
import type { BusMessage, BusRole, LinkKind, MessageSource } from "../models/bus";
import type { ResolvedConfig } from "../models/config";
import type { LogRecord } from "../models/log-record";
import type { PlatformMetadata } from "../utils/platform";
import { unrefTimer } from "../utils/unref";
import {
  createBroadcastLink,
  createChildrenLink,
  createDirectLink,
  createOpenFinLink,
  createOwnerLink,
  createParentLink,
  createWorkerLink,
  type Link,
  type Receive,
  type WorkerLike,
} from "./links";

/** Callbacks for handling records and journey events from connected realms. */
export interface BusHandlers {
  /** Processes records forwarded from child contexts. */
  onRecords: (records: LogRecord[]) => void;
  /** Applies journey updates received from the control bus. */
  onJourney: (journey: Journey | null) => void;
  /** Returns the active journey for inquiring child contexts. */
  onJourneyRequest: () => Journey | null;
  /** Invoked when a tab identifier collision is detected across windows. */
  onTabConflict: () => void;
}

/** Link types that a sender context may claim ownership over during handshakes. */
const OWNED: readonly LinkKind[] = ["children", "direct", "worker"];

/** Structural shape of fin.me identity metadata. */
interface OpenFinMe {
  isView?: boolean;
  identity?: { uuid?: string; name?: string };
}

/** Coordinates cross-realm communication, role resolution, and message dispatch. */
export class Bus {
  /** Current bus role. Defaults to "sender". */
  private role: BusRole = "sender";
  /** Upstream forwarding link, or null when acting as sender. */
  private upstream: Link | null = null;
  /** Open control plane links. */
  private readonly links: Link[] = [];
  /** Shared OpenFin InterApplicationBus link instance. */
  private openFinLink: Link | null = null;
  /** Indicates whether this context is the OpenFin platform provider. */
  private isOpenFinProvider = false;
  /** Indicates whether role resolution has completed. */
  private resolved = false;
  /** Active handshake state awaiting welcome response. */
  private awaitingWelcome: {
    link: LinkKind;
    settle: (ok: boolean) => void;
  } | null = null;

  /**
   * @param config Active configuration instance.
   * @param diagnostics Diagnostics reporter.
   * @param platform Platform runtime metadata.
   * @param contextId Unique context identifier for loop prevention.
   * @param tabId Tab identifier announced on broadcast channels.
   * @param handlers Callbacks for routed bus events.
   */
  constructor(
    private readonly config: ResolvedConfig,
    private readonly diagnostics: Diagnostics,
    private readonly platform: PlatformMetadata,
    private readonly contextId: string,
    private readonly tabId: string,
    private readonly handlers: BusHandlers,
  ) {}

  /** Returns the resolved bus role. */
  getRole(): BusRole {
    return this.role;
  }

  /** Returns whether role resolution has completed. */
  isResolved(): boolean {
    return this.resolved;
  }

  /**
   * Resolves bus role and establishes control links.
   * @returns Resolved role.
   */
  async start(): Promise<BusRole> {
    const { bus } = this.config;

    if (bus.mode === "off") {
      this.role = "sender";
      this.resolved = true;
      return this.role;
    }

    this.isOpenFinProvider = this.resolveOpenFinProvider();

    if (bus.mode === "sender" || bus.mode === "forwarder") {
      this.role = bus.mode;
      this.openControlLinks();
      if (this.role === "forwarder") {
        this.upstream = this.candidateUpstream();
        if (!this.upstream) {
          this.diagnostics.report(
            "bus.no_owner",
            'bus.mode is "forwarder" but there is no owner to forward to. Records will be dropped.',
          );
        }
      }
      this.resolved = true;
      this.announce();
      return this.role;
    }

    this.openControlLinks();

    // Direct synchronous attachment for same-origin parents.
    const direct = createDirectLink(this.receive, this.diagnostics);
    if (direct) {
      this.role = "forwarder";
      this.upstream = direct;
      this.resolved = true;
      this.diagnostics.report(
        "bus.role_resolved",
        "attached directly to the same-origin parent runtime",
        {
          role: "forwarder",
          via: "direct",
        },
      );
      this.announce();
      return this.role;
    }

    const candidate = this.candidateUpstream();

    if (!candidate) {
      this.role = "sender";
      this.resolved = true;
      this.diagnostics.report("bus.role_resolved", "no owner to forward to, sending directly", {
        role: "sender",
      });
      this.announce();
      return this.role;
    }

    const attempts = this.orphanPolicy() === "retry" ? this.config.bus.maxHandshakeAttempts : 1;

    let welcomed = false;
    for (let attempt = 0; attempt < attempts && !welcomed; attempt++) {
      welcomed = await this.handshake(candidate);
    }

    this.role = welcomed ? "forwarder" : "sender";
    this.upstream = welcomed ? candidate : null;
    if (!welcomed) {
      // OpenFin link remains open for control messages.
      if (candidate !== this.openFinLink) {
        candidate.close();
      }
      this.diagnostics.report(
        "bus.handshake_timeout",
        `no owner answered after ${String(attempts)} attempt(s) of ${String(this.config.bus.handshakeTimeoutMs)}ms, promoting to sender`,
        { via: candidate.kind, crossOrigin: this.isCrossOriginFrame() },
      );
    }
    this.diagnostics.report("bus.role_resolved", `role is ${this.role}`, {
      role: this.role,
      via: welcomed ? candidate.kind : "none",
    });

    this.resolved = true;
    this.announce();
    return this.role;
  }

  /**
   * Forwards records to the upstream owner if configured.
   * @param records Batch of log records to send.
   */
  sendRecords(records: LogRecord[]): void {
    this.upstream?.post({ t: "records", from: this.contextId, records });
  }

  /**
   * Synchronously processes direct messages from same-origin child contexts.
   * @param message Received bus message.
   * @param reply Direct response callback.
   */
  acceptDirect(message: BusMessage, reply: Receive): void {
    if (message.from === this.contextId) {
      return;
    }
    const source: MessageSource = { link: "direct", origin: "same-origin" };

    if (message.t === "hello") {
      if (this.canOwn("direct")) {
        reply(
          {
            t: "welcome",
            from: this.contextId,
            to: message.from,
            tabId: this.tabId,
          },
          source,
        );
      }
      return;
    }
    if (message.t === "journey?") {
      const current = this.handlers.onJourneyRequest();
      if (current) {
        reply({ t: "journey", from: this.contextId, journey: current }, source);
      }
      return;
    }
    this.receive(message, source);
  }

  /**
   * Connects a worker instance to the bus control plane.
   * @param worker Worker instance.
   */
  attachWorker(worker: WorkerLike): void {
    this.links.push(createWorkerLink(worker, this.receive, this.diagnostics));
  }

  /**
   * Broadcasts journey state changes to all connected links.
   * @param journey Active journey or null if ended.
   */
  broadcastJourney(journey: Journey | null): void {
    this.post({ t: "journey", from: this.contextId, journey });
  }

  /** Closes all open links and clears internal state. */
  destroy(): void {
    for (const link of this.allLinks()) {
      link.close();
    }
    this.links.length = 0;
    this.upstream = null;
    this.openFinLink = null;
  }

  /** Returns all unique active links including upstream. */
  private allLinks(): Link[] {
    if (!this.upstream || this.links.includes(this.upstream)) {
      return this.links;
    }
    return [...this.links, this.upstream];
  }

  /** Broadcasts a message across all open links. */
  private post(message: BusMessage): void {
    for (const link of this.allLinks()) {
      link.post(message);
    }
  }

  /** Sends a message exclusively over links matching the specified kind. */
  private postOver(link: LinkKind, message: BusMessage): void {
    for (const candidate of this.allLinks()) {
      if (candidate.kind === link) {
        candidate.post(message);
      }
    }
  }

  /** Routes incoming messages to registered handlers or upstream targets. */
  private readonly receive = (message: BusMessage, source: MessageSource): void => {
    if (message.from === this.contextId) {
      return;
    }

    switch (message.t) {
      case "hello":
        if (this.canOwn(source.link)) {
          this.postOver(source.link, {
            t: "welcome",
            from: this.contextId,
            to: message.from,
            tabId: this.tabId,
          });
        }
        break;

      case "welcome":
        if (message.to !== this.contextId) {
          break;
        }
        if (this.awaitingWelcome?.link === source.link) {
          this.awaitingWelcome.settle(true);
        }
        break;

      case "records":
        if (this.role === "sender") {
          this.handlers.onRecords(message.records);
        } else if (this.upstream && source.link !== this.upstream.kind) {
          // Relays records upstream in nested frame chains. Posting back onto
          // the link they arrived on would echo them to their sender.
          this.upstream.post(message);
        }
        break;

      case "journey":
        this.handlers.onJourney(message.journey);
        break;

      case "journey?": {
        const current = this.handlers.onJourneyRequest();
        if (current) {
          this.postOver(source.link, {
            t: "journey",
            from: this.contextId,
            journey: current,
          });
        }
        break;
      }

      case "tab":
        // Collisions only apply to distinct contexts sharing the broadcast
        // channel. The id comparison picks one side of the pair: without it
        // both colliding contexts report the conflict and both rename.
        if (
          source.link === "broadcast" &&
          message.tabId === this.tabId &&
          this.contextId > message.from
        ) {
          this.handlers.onTabConflict();
        }
        break;
    }
  };

  /** Returns whether this context can accept ownership over the given link type. */
  private canOwn(link: LinkKind): boolean {
    if (this.role !== "sender") {
      return false;
    }
    if (link === "openfin") {
      return this.isOpenFinProvider;
    }
    return OWNED.includes(link);
  }

  /** Resolves whether this context represents the OpenFin platform provider. */
  private resolveOpenFinProvider(): boolean {
    const configured = this.config.bus.openFinRole;
    if (configured !== "auto") {
      return configured === "provider";
    }
    if (this.platform.platform !== "openfin" && this.platform.platform !== "openfin_web") {
      return false;
    }

    const me = (globalThis as { fin?: { me?: OpenFinMe } }).fin?.me;
    if (!me?.identity || me.isView) {
      return false;
    }
    return Boolean(me.identity.name && me.identity.name === me.identity.uuid);
  }

  /** Resolves the handshake orphan policy for the current platform context. */
  private orphanPolicy(): "promote" | "retry" {
    const configured = this.config.bus.orphanPolicy;
    if (configured !== "auto") {
      return configured;
    }
    return this.isCrossOriginFrame() ? "retry" : "promote";
  }

  /** Tests whether the parent window is inaccessible due to cross-origin boundaries. */
  private isCrossOriginFrame(): boolean {
    if (typeof window === "undefined" || window.parent === window) {
      return false;
    }
    try {
      void (window.parent as unknown as Record<string, unknown>).location;
      return false;
    } catch {
      return true;
    }
  }

  /** Identifies the candidate upstream link based on platform hierarchy. */
  private candidateUpstream(): Link | null {
    if (this.platform.isWorker) {
      return createOwnerLink(this.receive, this.diagnostics);
    }
    if (!this.platform.isTopLevelDocument) {
      return createParentLink(this.receive, this.diagnostics);
    }
    if (
      this.platform.platform === "openfin" &&
      this.config.bus.openFinHost === "provider" &&
      !this.isOpenFinProvider
    ) {
      return this.ensureOpenFinLink();
    }
    return null;
  }

  /** Opens control links supported by the current runtime environment. */
  private openControlLinks(): void {
    const push = (link: Link | null): void => {
      if (link) {
        this.links.push(link);
      }
    };

    if (this.platform.isTopLevelDocument) {
      push(createChildrenLink(this.receive, this.config.bus.trustedOrigins, this.diagnostics));
      push(createBroadcastLink(this.config.bus.channelName, this.receive, this.diagnostics));
    }
    if (this.platform.platform === "openfin" || this.platform.platform === "openfin_web") {
      push(this.ensureOpenFinLink());
    }
  }

  /** Returns the singleton OpenFin InterApplicationBus link. */
  private ensureOpenFinLink(): Link | null {
    this.openFinLink ??= createOpenFinLink(
      this.config.bus.channelName,
      this.receive,
      this.diagnostics,
    );
    return this.openFinLink;
  }

  /**
   * Executes a hello/welcome handshake over candidate link.
   * @param candidate Upstream link candidate.
   * @returns True if welcome response arrived before timeout.
   */
  private handshake(candidate: Link): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.awaitingWelcome = null;
        clearTimeout(timer);
        resolve(result);
      };

      this.awaitingWelcome = { link: candidate.kind, settle: finish };
      // Declared below finish, which reads it: nothing can call finish until
      // the timer exists, because the welcome arrives through the post below.
      const timer = setTimeout(() => {
        finish(false);
      }, this.config.bus.handshakeTimeoutMs);
      unrefTimer(timer);
      candidate.post({ t: "hello", from: this.contextId, tabId: this.tabId });
    });
  }

  /** Broadcasts tab claim and queries existing journey state. */
  private announce(): void {
    this.postOver("broadcast", {
      t: "tab",
      from: this.contextId,
      tabId: this.tabId,
    });
    this.post({ t: "journey?", from: this.contextId });
  }
}

/** Buffers log records during bus role resolution with FIFO overflow eviction. */
export class BootBuffer {
  /** Held records in FIFO order. */
  private records: LogRecord[] = [];

  /**
   * @param config Active configuration instance.
   * @param diagnostics Diagnostics reporter.
   */
  constructor(
    private readonly config: ResolvedConfig,
    private readonly diagnostics: Diagnostics,
  ) {}

  /**
   * Buffers a record, dropping the oldest when capacity is exceeded.
   * @param record Record to buffer.
   */
  push(record: LogRecord): void {
    if (this.records.length >= this.config.bus.maxBootBufferRecords) {
      this.records.shift();
      this.diagnostics.count("record.dropped_boot_buffer_full");
    }
    this.records.push(record);
  }

  /**
   * Drains and returns all buffered records in FIFO order.
   * @returns Buffered log records.
   */
  release(): LogRecord[] {
    const released = this.records;
    this.records = [];
    return released;
  }
}
