// src/bus/bus.ts
//
// Resolves the bus role and routes messages between realms.

import {
  BUS_CHANNEL_NAME,
  BUS_HANDSHAKE_TIMEOUT_MS,
  BUS_MAX_HANDSHAKE_ATTEMPTS,
  REMOTE_SAMPLING_POLL_MS,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import type { Journey } from "../core/journey";
import { applyRemote, parseRemoteRules } from "../core/remote-rules";
import type { RemoteSlot } from "../core/remote-sampling";
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

/** Handshake timing for a forwarder waiting on an owner. */
export interface HandshakeOptions {
  /** Maximum time that a forwarder waits for an owner to answer, in milliseconds. */
  timeoutMs: number;
  /** Attempts allowed before a cross-origin forwarder promotes itself to sender. */
  maxAttempts: number;
}

/** Default handshake timing. Tests build a bus with shorter values. */
export const HANDSHAKE_OPTIONS: HandshakeOptions = {
  timeoutMs: BUS_HANDSHAKE_TIMEOUT_MS,
  maxAttempts: BUS_MAX_HANDSHAKE_ATTEMPTS,
};

/** Callbacks for handling records and journey events from connected realms. */
export interface BusHandlers {
  /** Processes records forwarded from child contexts. */
  onRecords: (records: LogRecord[]) => void;
  /** Applies journey updates received from the control bus. */
  onJourney: (journey: Journey | null) => void;
  /** Returns the active journey to a child context that requests it. */
  onJourneyRequest: () => Journey | null;
  /** Runs when two windows use the same tab identifier. */
  onTabConflict: () => void;
  /** Slot of the runtime for the remote sampling rules. The bus reads it and fills it. */
  remote: RemoteSlot;
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
  /** Current bus role. The default is "sender". */
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
  /** Timer that asks the upstream owner for the remote sampling rules. */
  private rulesPoll: ReturnType<typeof setInterval> | undefined;
  /** True after destroy(). A handshake that ends later must not start a timer. */
  private destroyed = false;
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
    private readonly handshakeOptions: HandshakeOptions = HANDSHAKE_OPTIONS,
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
            'bus.mode is "forwarder". No owner exists. The library drops the records of this context.',
          );
        }
      }
      this.resolved = true;
      this.announce();
      return this.role;
    }

    this.openControlLinks();

    // A same-origin parent runtime accepts a direct synchronous link.
    const direct = createDirectLink(this.receive, this.diagnostics);
    if (direct) {
      this.role = "forwarder";
      this.upstream = direct;
      this.resolved = true;
      this.diagnostics.report(
        "bus.role_resolved",
        "This context attached directly to the runtime of its same-origin parent.",
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
      this.diagnostics.report(
        "bus.role_resolved",
        "No owner exists. This context sends its own records.",
        {
          role: "sender",
        },
      );
      this.announce();
      return this.role;
    }

    const attempts = this.orphanPolicy() === "retry" ? this.handshakeOptions.maxAttempts : 1;

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
        `No owner answered after ${String(attempts)} attempt(s) of ${String(this.handshakeOptions.timeoutMs)} ms. This context becomes the sender.`,
        { via: candidate.kind, crossOrigin: this.isCrossOriginFrame() },
      );
    }
    this.diagnostics.report("bus.role_resolved", `The bus role is ${this.role}.`, {
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
    // A direct link has no channel from the parent to the child. The parent answers here.
    if (message.t === "sampling?") {
      reply(this.rulesAnswer(message.from), source);
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
    this.destroyed = true;
    clearInterval(this.rulesPoll);
    this.rulesPoll = undefined;
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

  /** Sends a message only over links of the given kind. */
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
        } else if (this.upstream && this.canRelay(source.link)) {
          // Relays records upstream in nested frame chains.
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

      case "sampling?":
        // A forwarder answers only its own children. A sibling on its upstream link asks too.
        // A sibling answer on OpenFin gives N squared messages, and a stale copy can win.
        if (
          this.role === "forwarder" ? source.link !== this.upstream?.kind : this.canOwn(source.link)
        ) {
          this.postOver(source.link, this.rulesAnswer(message.from));
        }
        break;

      case "sampling":
        if (this.acceptsRules(message.to, source)) {
          this.applyRules(message.rules);
        }
        break;

      case "tab":
        // A collision applies only to two different contexts on the broadcast channel.
        // The id comparison selects one context of the pair.
        // Without it, both contexts report the conflict and rename.
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

  /**
   * Tells whether records from a link can go upstream. Records that go back on
   * their arrival link return to their sender. A direct link is an exception.
   * Each direct link is one call into one parent. Thus two direct links in a
   * chain are different links.
   * @param link Kind of the link the records arrived on.
   * @returns True if the relay is safe.
   */
  private canRelay(link: LinkKind): boolean {
    return link === "direct" || link !== this.upstream?.kind;
  }

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
    return this.isCrossOriginFrame() ? "retry" : "promote";
  }

  /** Tests whether the parent window is inaccessible due to cross-origin boundaries. */
  private isCrossOriginFrame(): boolean {
    if (typeof window === "undefined" || window.parent === window) {
      return false;
    }
    try {
      // A cross-origin parent throws on this read. Lint rejects a bare property read.
      Reflect.get(window.parent, "location");
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
    if (this.platform.platform === "openfin" && !this.isOpenFinProvider) {
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
      push(createBroadcastLink(BUS_CHANNEL_NAME, this.receive, this.diagnostics));
    }
    if (this.platform.platform === "openfin" || this.platform.platform === "openfin_web") {
      push(this.ensureOpenFinLink());
    }
  }

  /** Returns the singleton OpenFin InterApplicationBus link. */
  private ensureOpenFinLink(): Link | null {
    this.openFinLink ??= createOpenFinLink(
      BUS_CHANNEL_NAME,
      this.platform.openfinUuid,
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
      // finish reads timer, which the code declares after finish. This order is safe.
      // finish can run only after the post below. The timer exists at that time.
      const timer = setTimeout(() => {
        finish(false);
      }, this.handshakeOptions.timeoutMs);
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
    this.pollRules();
  }

  /**
   * Builds the answer to a sampling question. Null rules end the copy of the forwarder.
   * @param to Context id of the forwarder that asked.
   * @returns The answer.
   */
  private rulesAnswer(to: string): BusMessage {
    const rules = this.handlers.remote.sampling?.wire() ?? null;

    return { t: "sampling", from: this.contextId, to, rules };
  }

  /**
   * Tests whether this context accepts sampling rules from a source.
   * @param to Context id that the answer names.
   * @param source Link and origin of the answer.
   * @returns True only for an answer from the upstream owner to this context.
   */
  private acceptsRules(to: string, source: MessageSource): boolean {
    // Accept rules only from the upstream owner. A sibling on a shared link is not trusted.
    if (this.role !== "forwarder" || to !== this.contextId || source.link !== this.upstream?.kind) {
      return false;
    }

    // A page on another origin can embed this app. It must not lower minLevel and read the records.
    const { origin } = source;

    if (
      source.link === "parent" &&
      origin !== location.origin &&
      !this.config.bus.trustedOrigins.includes(origin)
    ) {
      this.diagnostics.report(
        "bus.untrusted_origin",
        `The bus ignored sampling rules from ${origin}. If you own this origin, add it to bus.trustedOrigins.`,
        { origin, type: "sampling" },
      );
      return false;
    }

    return true;
  }

  /**
   * Applies the rules of an answer. It ignores rules that are not valid.
   * @param raw Rules of the answer, or null when the upstream has none.
   */
  private applyRules(raw: unknown): void {
    if (raw === null) {
      applyRemote(this.handlers.remote, this.config, null);
      return;
    }

    const update = parseRemoteRules(raw, this.diagnostics);

    if (update) {
      applyRemote(this.handlers.remote, this.config, update);
    }
  }

  /**
   * Asks the upstream owner for the remote sampling rules now, then at each poll interval.
   * A direct link cannot push the rules to a child. A poll works on each link kind.
   */
  private pollRules(): void {
    const { upstream } = this;

    if (this.destroyed || this.role !== "forwarder" || !upstream) {
      return;
    }

    // Read the config at each poll. A later configure() can turn remote sampling on or off.
    const ask = (): void => {
      if (this.config.sampling.remote) {
        upstream.post({ t: "sampling?", from: this.contextId });
      }
    };

    ask();
    this.rulesPoll = setInterval(ask, REMOTE_SAMPLING_POLL_MS);
    unrefTimer(this.rulesPoll);
  }
}
