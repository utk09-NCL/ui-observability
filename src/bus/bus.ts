// src/bus/bus.ts
//
// Resolves the bus role and routes messages between realms.

import {
  BUS_CHANNEL_NAME,
  BUS_HANDSHAKE_TIMEOUT_MS,
  BUS_MAX_HANDSHAKE_ATTEMPTS,
  BUS_TYPE,
  REMOTE_SAMPLING_POLL_MS,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { type Journey, parseJourney } from "../core/journey";
import { applyRemote, parseRemoteRules } from "../core/remote-rules";
import type { RemoteSlot } from "../core/remote-sampling";
import type { BusMessage, BusRole, LinkKind, MessageSource } from "../models/bus";
import type { SourceOptions, FrameOptions } from "../models/bus";
import { validMessage } from "./validation";
import type { JourneyScope, ResolvedConfig } from "../models/config";
import type { LogRecord } from "../models/log-record";
import { getFin } from "../utils/openfin";
import type { PlatformMetadata } from "../utils/platform";
import { countInWindow, windowEnded } from "../utils/fixed-window";
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
  /** Adopts the delivery context of the owner. False refuses a different identity. */
  onSecurityContext?: (id: string) => boolean;
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

/** Journey scope after the bus resolves "auto". */
type ResolvedScope = Exclude<JourneyScope, "auto">;

/** Coordinates cross-realm communication, role resolution, and message dispatch. */
export class Bus {
  /** Window and worker registrations with their permissions. */
  private readonly sources = new Map<object, SourceOptions & { origin?: string }>();
  /** Message counts for each window and worker in the current rate window. */
  private readonly rates = new WeakMap<object, { start: number; count: number }>();
  /** Message counts for each named source or link in the current rate window. */
  private readonly channelRates = new Map<string, { start: number; count: number }>();

  /**
   * Checks if this source can receive a control message. A window can read a message
   * even when its address names another window.
   * @param message Control message to send.
   * @param peer Window or worker that receives the message.
   * @returns True if the source has the required permission.
   */
  private mayPost(message: BusMessage, peer: object): boolean {
    const permissions = this.sources.get(peer)?.permissions;
    if (!permissions) return this.config.bus.sourcePolicy === "trusted-origin";
    if (message.t === BUS_TYPE.journey) return permissions.includes("journey:read");
    if (message.t === BUS_TYPE.journeyRequest) return permissions.includes("journey:write");
    if (message.t === BUS_TYPE.sampling) return permissions.includes("sampling:read");
    return true;
  }

  /**
   * Registers one child window and its permissions.
   * @param frame Frame element or window to register.
   * @param options Expected origin and source permissions.
   * @returns Function that removes this registration.
   */
  registerFrame(frame: HTMLIFrameElement | Window, options: FrameOptions): () => void {
    // Use instanceof, not "in". The "in" operator throws on a cross-origin window.
    const element = typeof HTMLIFrameElement === "undefined" ? undefined : HTMLIFrameElement;
    const source = element && frame instanceof element ? frame.contentWindow : frame;
    if (!source || new URL(options.origin).origin !== options.origin || options.origin === "null")
      throw new Error("A frame registration requires a window and an exact origin.");
    const registration = { ...options, permissions: [...(options.permissions ?? ["records"])] };
    this.sources.set(source, registration);
    this.ensureChildrenLink();
    return () => {
      if (this.sources.get(source) === registration) this.sources.delete(source);
    };
  }

  /**
   * Checks if a source is permitted at the given origin.
   * @param source Window or port that sent the message.
   * @param origin Origin supplied by the transport.
   * @returns True if the current source policy permits this source.
   */
  isRegistered(source: object | null, origin: string): boolean {
    if (!source) return false;
    const registration = this.sources.get(source);
    // A registration binds its exact origin under each policy. It needs no trustedOrigins entry.
    if (registration) {
      return registration.origin === origin;
    }
    if (this.config.bus.sourcePolicy === "registered") {
      return false;
    }
    return (
      origin !== "null" &&
      (origin === location.origin || this.config.bus.trustedOrigins.includes(origin))
    );
  }

  /**
   * Sends the new context id to child frames, workers and OpenFin views. Other tabs keep their
   * own context.
   */
  rotateContext(): void {
    // Only the owner sends on the OpenFin link. Without this message, each view keeps the old id.
    this.passContext(this.role === "sender");
  }

  /**
   * Sends the context id to child frames and workers.
   * @param openFin True to send it to OpenFin views too.
   */
  private passContext(openFin: boolean): void {
    const message: BusMessage = {
      t: BUS_TYPE.securityContext,
      from: this.contextId,
      id: this.config.securityContext.id,
    };
    this.postOver("children", message);
    this.postOver("worker", message);
    if (openFin) {
      this.postOver("openfin", message);
    }
  }
  /** Current bus role. The default is "sender". */
  private role: BusRole = "sender";
  /** Upstream forwarding link, or null when acting as sender. */
  private upstream: Link | null = null;
  /** Open control plane links. */
  private readonly links: Link[] = [];
  /** Shared OpenFin InterApplicationBus link instance. */
  private openFinLink: Link | null = null;
  /** True if this context is the OpenFin platform provider. */
  private isOpenFinProvider = false;
  /** Timer that asks the upstream owner for the remote sampling rules. */
  private rulesPoll: ReturnType<typeof setInterval> | undefined;
  /** True after destroy(). A handshake that ends later must not start a timer. */
  private destroyed = false;
  /** Context id of the owner that answered the handshake. Null with no handshake. */
  private ownerId: string | null = null;
  /** Transport identity of the owner from the handshake. */
  private ownerPeer?: object | string;
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

  /**
   * Resolves bus role and establishes control links.
   * @returns Resolved role.
   */
  async start(): Promise<BusRole> {
    const { bus } = this.config;

    if (bus.mode === "off") {
      this.role = "sender";
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
      this.announce();
      return this.role;
    }

    this.openControlLinks();

    // A same-origin parent runtime accepts a direct synchronous link.
    const direct = createDirectLink(this.receive, this.diagnostics);
    if (direct) {
      this.role = "forwarder";
      this.upstream = direct;
      await this.handshake(direct);
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

    this.announce();
    return this.role;
  }

  /**
   * Forwards records to the upstream owner if configured.
   * @param records Batch of log records to send.
   */
  sendRecords(records: LogRecord[]): void {
    const { maxRecordsPerMessage, maxMessageBytes } = this.config.bus;
    const encoder = new TextEncoder();
    const size = (value: unknown): number =>
      maxMessageBytes ? encoder.encode(JSON.stringify(value)).length : 0;
    const message = (chunk: LogRecord[]): BusMessage => ({
      t: BUS_TYPE.records,
      from: this.contextId,
      records: chunk,
      routingContextId: this.config.securityContext.id || undefined,
    });

    // Measure each record one time. A message is the empty envelope, its records and the commas.
    const envelope = size(message([]));
    let chunk: LogRecord[] = [];
    let bytes = envelope;

    for (const record of records) {
      const recordBytes = size(record);
      if (maxMessageBytes && envelope + recordBytes > maxMessageBytes) {
        this.diagnostics.count("bus.rejected_message");
        continue;
      }

      const comma = chunk.length > 0 ? 1 : 0;
      if (
        (maxRecordsPerMessage && chunk.length >= maxRecordsPerMessage) ||
        (maxMessageBytes && bytes + comma + recordBytes > maxMessageBytes)
      ) {
        this.upstream?.post(message(chunk));
        chunk = [];
        bytes = envelope;
      }

      bytes += (chunk.length > 0 ? 1 : 0) + recordBytes;
      chunk.push(record);
    }

    if (chunk.length > 0) {
      this.upstream?.post(message(chunk));
    }
  }

  /**
   * Synchronously processes direct messages from same-origin child contexts.
   * @param message Received bus message.
   * @param reply Direct response callback.
   */
  acceptDirect(message: BusMessage, reply: Receive, peer?: Window): void {
    // The child gets the plain source. The reply field stays on this side.
    const plain: MessageSource = { link: "direct", origin: "same-origin", peer };
    const source: MessageSource = {
      ...plain,
      reply: (answer) => {
        reply(answer, plain);
      },
    };
    if (!this.acceptsMessage(message, source, true)) return;
    if (message.from === this.contextId) {
      return;
    }

    // A direct link has no channel from the parent to the child. The parent answers here. The
    // forwarder rule in routeMessage() refuses a sampling question on a direct link.
    if (message.t === BUS_TYPE.samplingRequest) {
      reply(this.rulesAnswer(message.from), plain);
      return;
    }
    // A context that waits for its own owner has no final id. It sends no id.
    if (
      message.t === BUS_TYPE.records &&
      !this.awaitingWelcome &&
      message.routingContextId !== this.config.securityContext.id
    ) {
      reply(
        { t: BUS_TYPE.securityContext, from: this.contextId, id: this.config.securityContext.id },
        plain,
      );
    }
    this.routeMessage(message, source);
  }

  /**
   * Connects a worker instance to the bus control plane.
   * @param worker Worker instance.
   */
  attachWorker(worker: WorkerLike, options: SourceOptions = {}): () => void {
    const registration = { ...options, permissions: [...(options.permissions ?? ["records"])] };
    this.sources.set(worker, registration);
    const raw = createWorkerLink(worker, this.receive, this.diagnostics);
    const link: Link = {
      ...raw,
      post: (message) => {
        if (this.mayPost(message, worker)) raw.post(message);
      },
    };
    this.links.push(link);
    return () => {
      link.close();
      const index = this.links.indexOf(link);
      if (index >= 0) this.links.splice(index, 1);
      if (this.sources.get(worker) === registration) this.sources.delete(worker);
    };
  }

  /**
   * Sends journey state changes over each link of the journey scope.
   * @param journey Active journey or null if ended.
   */
  broadcastJourney(journey: Journey | null): void {
    this.postJourney({ t: BUS_TYPE.journey, from: this.contextId, journey });
  }

  /** Closes all open links and clears internal state. */
  destroy(): void {
    this.sources.clear();
    this.destroyed = true;
    clearInterval(this.rulesPoll);
    this.rulesPoll = undefined;
    for (const link of this.allLinks()) {
      link.close();
    }
    this.links.length = 0;
    this.upstream = null;
    this.ownerId = null;
    this.openFinLink = null;
  }

  /** Returns all unique active links including upstream. */
  private allLinks(): Link[] {
    if (!this.upstream || this.links.includes(this.upstream)) {
      return this.links;
    }
    return [...this.links, this.upstream];
  }

  /** Sends a message only over links of the given kind. */
  private postOver(link: LinkKind, message: BusMessage): void {
    for (const candidate of this.allLinks()) {
      if (candidate.kind === link) {
        candidate.post(message);
      }
    }
  }

  /** Sends a journey message over each link of the journey scope. */
  private postJourney(message: BusMessage): void {
    for (const link of this.allLinks()) {
      if (this.journeyLink(link.kind)) {
        link.post(message);
      }
    }
  }

  /** Routes incoming messages to registered handlers or upstream targets. */
  private readonly receive = (message: BusMessage, source: MessageSource): void => {
    // A message on the direct link here is an answer from the parent. acceptDirect() takes the
    // messages of a direct child. Thus only the children and worker links carry child traffic.
    const child = source.link === "children" || source.link === "worker";
    if (this.acceptsMessage(message, source, child)) {
      this.routeMessage(message, source);
    }
  };

  /**
   * Checks the source, the message limits and the message shape before delivery.
   * @param message Message from the source.
   * @param source Link and identity of the source.
   * @param child True if the source is a child of this context.
   * @returns True if the bus can accept the message.
   */
  private acceptsMessage(message: BusMessage, source: MessageSource, child: boolean): boolean {
    if (this.destroyed) {
      return false;
    }

    let accepted: boolean;
    try {
      accepted = this.passesChecks(message, source, child);
    } catch {
      // A value that JSON cannot encode, or a non-finite number under strict validation.
      // The count below reports this rejection.
      accepted = false;
    }

    if (!accepted) {
      this.diagnostics.count("bus.rejected_message");
    }
    return accepted;
  }

  /**
   * Runs the source, budget, shape and permission checks. Each check returns false, not an error.
   * A flood of rejected messages then makes no stack traces.
   * @param message Message from the source.
   * @param source Link and identity of the source.
   * @param child True if the source is a child of this context.
   * @returns True if the message passes each check.
   */
  private passesChecks(message: BusMessage, source: MessageSource, child: boolean): boolean {
    const { bus } = this.config;
    const registration =
      typeof source.peer === "object" ? this.sources.get(source.peer) : undefined;
    if (child && bus.sourcePolicy === "registered" && !registration) {
      return false;
    }

    const object = typeof source.peer === "object" ? source.peer : undefined;
    const key = typeof source.peer === "string" ? source.peer : source.link;
    const now = Date.now();
    const rate = (object ? this.rates.get(object) : this.channelRates.get(key)) ?? {
      start: now,
      count: 0,
    };
    if (object) {
      this.rates.set(object, rate);
    } else {
      for (const [peer, entry] of this.channelRates) {
        if (windowEnded(entry, 1000, now)) {
          this.channelRates.delete(peer);
        }
      }
      if (
        bus.maxTrackedSources &&
        this.channelRates.size >= bus.maxTrackedSources &&
        !this.channelRates.has(key)
      ) {
        return false;
      }
      this.channelRates.set(key, rate);
    }

    // Count with no limit when the limit is 0. The window of a named source then stays current.
    if (!countInWindow(rate, bus.maxMessagesPerSecond || Infinity, 1000)) {
      return false;
    }

    const encoded = JSON.stringify(message, (_key, value: unknown) => {
      if (bus.validation === "strict" && typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("Non-finite value");
      }
      return value;
    });
    if (bus.maxMessageBytes && new TextEncoder().encode(encoded).length > bus.maxMessageBytes) {
      return false;
    }
    if (bus.validation === "strict" && !validMessage(message)) {
      return false;
    }
    if (
      message.t === BUS_TYPE.records &&
      bus.maxRecordsPerMessage &&
      message.records.length > bus.maxRecordsPerMessage
    ) {
      return false;
    }

    if (registration) {
      const permission =
        message.t === BUS_TYPE.records
          ? "records"
          : message.t === BUS_TYPE.journey
            ? "journey:write"
            : message.t === BUS_TYPE.journeyRequest
              ? "journey:read"
              : message.t === BUS_TYPE.samplingRequest
                ? "sampling:read"
                : undefined;
      if (permission && !registration.permissions?.includes(permission)) {
        return false;
      }
    }

    // Only an upstream owner can publish these control messages.
    if (child && (message.t === BUS_TYPE.sampling || message.t === BUS_TYPE.securityContext)) {
      return false;
    }

    // Under the registered policy, broadcast is a control channel. It carries no records.
    return !(
      bus.sourcePolicy === "registered" &&
      source.link === "broadcast" &&
      message.t === BUS_TYPE.records
    );
  }

  /**
   * Gives an accepted message to its handler or the upstream link.
   * @param message Message that passed the source and shape checks.
   * @param source Link and identity of the source.
   */
  private routeMessage(message: BusMessage, source: MessageSource): void {
    if (message.from === this.contextId) {
      return;
    }

    switch (message.t) {
      case BUS_TYPE.hello:
        if (this.canOwn(source.link)) {
          // A context that waits for its own owner has only a temporary id. Send no id then.
          // announce() sends the final id when the role is known.
          this.answer(source, {
            t: BUS_TYPE.welcome,
            from: this.contextId,
            to: message.from,
            tabId: this.tabId,
            routingContextId: this.awaitingWelcome
              ? undefined
              : this.config.securityContext.id || undefined,
          });
        }
        break;

      case BUS_TYPE.welcome:
        if (message.to !== this.contextId) {
          break;
        }
        if (
          this.awaitingWelcome?.link === source.link ||
          (this.upstream?.kind === source.link && this.ownerId === null)
        ) {
          // Keep the owner. Only it can set the journey of this context on a shared link.
          this.ownerId = message.from;
          this.ownerPeer = source.peer;
          const before = this.config.securityContext.id;
          if (
            message.routingContextId &&
            this.handlers.onSecurityContext?.(message.routingContextId) === false
          )
            break;
          // A child of this context can hold the old id. Send it the id of the owner. During a
          // handshake the role can still be "sender". Do not send on the OpenFin link here.
          if (this.config.securityContext.id !== before) {
            this.passContext(false);
          }
          this.awaitingWelcome?.settle(true);
        }
        break;

      case BUS_TYPE.records:
        if (
          this.config.securityContext.isolation &&
          this.config.securityContext.id &&
          message.routingContextId !== this.config.securityContext.id
        ) {
          this.diagnostics.count("security.context_mismatch");
          break;
        }
        if (this.role === "sender") {
          this.handlers.onRecords(message.records);
        } else if (this.upstream && this.canRelay(source.link)) {
          // Relays records upstream in nested frame chains.
          this.upstream.post(message);
        }
        break;

      case BUS_TYPE.securityContext:
        if (
          source.link === this.upstream?.kind &&
          this.ownerId === message.from &&
          this.ownerPeer === source.peer
        ) {
          if (this.handlers.onSecurityContext?.(message.id) !== false) this.rotateContext();
        }
        break;

      case BUS_TYPE.journey:
        if (this.acceptsJourney(message, source)) {
          this.applyJourney(message.journey);
        }
        break;

      case BUS_TYPE.journeyRequest: {
        const current = this.handlers.onJourneyRequest();
        // Address the answer. On a shared link, each other context ignores it.
        if (current && this.journeyLink(source.link)) {
          this.answer(source, {
            t: BUS_TYPE.journey,
            from: this.contextId,
            to: message.from,
            journey: current,
          });
        }
        break;
      }

      case BUS_TYPE.samplingRequest:
        // A forwarder answers only its own children. A sibling on its upstream link asks too.
        // A sibling answer on OpenFin gives N squared messages, and a stale copy can win.
        if (
          this.role === "forwarder" ? source.link !== this.upstream?.kind : this.canOwn(source.link)
        ) {
          this.answer(source, this.rulesAnswer(message.from));
        }
        break;

      case BUS_TYPE.sampling:
        if (this.acceptsRules(message.to, source)) {
          this.applyRules(message.rules);
        }
        break;

      case BUS_TYPE.tab:
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
  }

  /**
   * Answers the source of a message. A link that can address one source sends to it only.
   * @param source Link and identity of the source.
   * @param message Answer to send.
   */
  private answer(source: MessageSource, message: BusMessage): void {
    if (source.reply) {
      source.reply(message);
      return;
    }
    this.postOver(source.link, message);
  }

  /**
   * Tells if records from a link can go upstream. Records that go back on
   * their arrival link return to their sender. A direct link is an exception.
   * Each direct link is one call into one parent. Thus two direct links in a
   * chain are different links.
   * @param link Kind of the link the records arrived on.
   * @returns True if the relay is safe.
   */
  private canRelay(link: LinkKind): boolean {
    return link === "direct" || link !== this.upstream?.kind;
  }

  /** Returns true if this context can be the owner of the given link type. */
  private canOwn(link: LinkKind): boolean {
    // A forwarder that knows its owner owns its own children. It relays their records upstream.
    const owner = this.role === "sender" || this.ownerId !== null;
    if (!owner) {
      return false;
    }
    if (link === "openfin") {
      return this.role === "sender" && this.isOpenFinProvider;
    }
    return OWNED.includes(link);
  }

  /** Finds if this context is the OpenFin platform provider. */
  private resolveOpenFinProvider(): boolean {
    const configured = this.config.bus.openFinRole;
    if (configured !== "auto") {
      return configured === "provider";
    }
    if (this.platform.platform !== "openfin" && this.platform.platform !== "openfin_web") {
      return false;
    }

    const me = getFin()?.me;
    if (!me?.identity || me.isView) {
      return false;
    }
    return Boolean(me.identity.name && me.identity.name === me.identity.uuid);
  }

  /** Resolves the handshake orphan policy for the current platform context. */
  private orphanPolicy(): "promote" | "retry" {
    return this.isCrossOriginFrame() ? "retry" : "promote";
  }

  /** Tests if a cross-origin boundary blocks access to the parent window. */
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
      return createParentLink(this.receive, this.config.bus.trustedOrigins, this.diagnostics);
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

    if (!this.platform.isWorker) this.ensureChildrenLink();
    if (this.platform.isTopLevelDocument) {
      push(createBroadcastLink(BUS_CHANNEL_NAME, this.receive, this.diagnostics));
    }
    if (this.platform.platform === "openfin" || this.platform.platform === "openfin_web") {
      push(this.ensureOpenFinLink());
    }
  }

  /** Opens the link to child frames if it is not already open. */
  private ensureChildrenLink(): void {
    if (this.links.some((link) => link.kind === "children")) return;
    const link = createChildrenLink(
      this.receive,
      this.config.bus.trustedOrigins,
      this.diagnostics,
      (source, origin) => {
        const accepted = this.isRegistered(source, origin);
        if (!accepted) {
          this.diagnostics.count("bus.rejected_message");
          // A registered window that speaks from another origin is also untrusted. Without this
          // report, a registration with a wrong origin stops the frame with no named cause.
          const registered = source !== null && this.sources.has(source);
          const trusted =
            origin === location.origin || this.config.bus.trustedOrigins.includes(origin);
          if (registered || !trusted) {
            this.diagnostics.report(
              "bus.untrusted_origin",
              "The bus rejected a message from an untrusted origin.",
            );
          }
        }
        return accepted;
      },
      (message, source) => this.mayPost(message, source),
    );
    if (link) this.links.push(link);
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
      candidate.post({ t: BUS_TYPE.hello, from: this.contextId, tabId: this.tabId });
    });
  }

  /** Broadcasts tab claim and queries existing journey state. */
  private announce(): void {
    this.postOver("broadcast", {
      t: BUS_TYPE.tab,
      from: this.contextId,
      tabId: this.tabId,
    });
    if (this.upstream && this.ownerId === null)
      this.upstream.post({ t: BUS_TYPE.hello, from: this.contextId, tabId: this.tabId });
    this.postJourney({ t: BUS_TYPE.journeyRequest, from: this.contextId });
    this.pollRules();
    // The role is final now. A child welcomed during the handshake got no id. Send it the final id.
    this.passContext(false);
  }

  /**
   * Resolves the journey scope. "auto" gives "origin" in OpenFin and "tab" in a browser.
   * @returns The scope in force.
   */
  private journeyScope(): ResolvedScope {
    const { scope } = this.config.journey;
    if (scope !== "auto") {
      return scope;
    }

    const { platform } = this.platform;
    return platform === "openfin" || platform === "openfin_web" ? "origin" : "tab";
  }

  /**
   * Tests if a link carries journey messages in the scope in force.
   * Only "origin" uses the broadcast link. That link reaches each tab of the origin.
   * @param link Link kind.
   * @returns True if the link carries journey messages.
   */
  private journeyLink(link: LinkKind): boolean {
    const scope = this.journeyScope();
    if (scope === "context") {
      return false;
    }

    return scope === "origin" || link !== "broadcast";
  }

  /**
   * Tests if this context adopts a journey message.
   * @param message Journey message.
   * @param source Link and origin of the message.
   * @returns True for a message on a journey link, to this context, from an accepted sender.
   * In "tab" scope, only the owner of a forwarder is an accepted sender.
   */
  private acceptsJourney(
    message: Extract<BusMessage, { t: typeof BUS_TYPE.journey }>,
    source: MessageSource,
  ): boolean {
    if (!this.journeyLink(source.link)) {
      return false;
    }

    if (message.to !== undefined && message.to !== this.contextId) {
      return false;
    }

    return (
      this.journeyScope() === "origin" ||
      (this.fromOwner(message.from, source.link) &&
        (this.ownerPeer === undefined || this.ownerPeer === source.peer))
    );
  }

  /**
   * Tests if a message comes from the upstream owner of this forwarder.
   * @param from Context id of the sender.
   * @param link Link kind of the message.
   * @returns True for the upstream link and, after a handshake, the owner that answered it.
   */
  private fromOwner(from: string, link: LinkKind): boolean {
    if (this.role !== "forwarder" || link !== this.upstream?.kind) {
      return false;
    }

    return this.ownerId === null || from === this.ownerId;
  }

  /**
   * Parses a journey payload from another realm and gives it to the runtime.
   * @param payload Journey, or null when the journey ended.
   */
  private applyJourney(payload: unknown): void {
    if (payload === null) {
      this.handlers.onJourney(null);
      return;
    }

    const journey = parseJourney(payload);
    if (journey === null) {
      this.diagnostics.report(
        "record.dropped_malformed",
        "The bus dropped a journey message. Its payload is not a journey.",
        { type: "journey" },
      );
      return;
    }

    this.handlers.onJourney(journey);
  }

  /**
   * Builds the answer to a sampling question. Null rules end the copy of the forwarder.
   * @param to Context id of the forwarder that asked.
   * @returns The answer.
   */
  private rulesAnswer(to: string): BusMessage {
    const rules = this.handlers.remote.sampling?.wire() ?? null;

    return { t: BUS_TYPE.sampling, from: this.contextId, to, rules };
  }

  /**
   * Tests if this context accepts sampling rules from a source.
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

    return this.ownerPeer === undefined || this.ownerPeer === source.peer;
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
        upstream.post({ t: BUS_TYPE.samplingRequest, from: this.contextId });
      }
    };

    ask();
    this.rulesPoll = setInterval(ask, REMOTE_SAMPLING_POLL_MS);
    unrefTimer(this.rulesPoll);
  }
}
