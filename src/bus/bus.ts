// src/bus/bus.ts
//
// Resolves the bus role and routes messages between realms.

import {
  BUS_CHANNEL_NAME,
  BUS_FLUSH_GAP_MS,
  BUS_HANDSHAKE_TIMEOUT_MS,
  BUS_MAX_FLUSH_REQUESTS,
  BUS_MAX_FLUSH_REQUESTS_PER_SOURCE,
  BUS_MAX_HANDSHAKE_ATTEMPTS,
  BUS_MAX_TRACKED_SOURCES,
  BUS_TYPE,
  FLUSH_TIMEOUT_MAX_MS,
  REMOTE_SAMPLING_POLL_MS,
} from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { type Journey, parseJourney } from "../core/journey";
import { applyRemote, parseRemoteRules } from "../core/remote-rules";
import type { RemoteSlot } from "../core/remote-sampling";
import type { BusMessage, BusRole, LinkKind, MessageSource } from "../models/bus";
import type { SourceOptions, FrameOptions } from "../models/bus";
import { readFlushResult, validMessage } from "./validation";
import type { JourneyScope, ResolvedConfig } from "../models/config";
import type { FlushResult } from "../models/health";
import type { LogRecord } from "../models/log-record";
import { newId } from "../utils/identity";
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
  frameOrigin,
  type Link,
  type Receive,
  type WorkerLike,
} from "./links";

/** Handshake timing for a forwarder waiting on an owner. */
export interface HandshakeOptions {
  /** How long a forwarder waits for an owner to answer, in milliseconds. */
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
  /** Adopts the owner's delivery context. Returning false refuses a different identity. */
  onSecurityContext?: (id: string) => boolean;
  /** Processes records forwarded from child contexts. */
  onRecords: (records: LogRecord[]) => void;
  /**
   * Returns true while the runtime is paused. A paused forwarder hands a child's records to
   * onRecords, which drops them, instead of relaying them upstream.
   */
  paused?: () => boolean;
  /** Applies journey updates received from the control bus. */
  onJourney: (journey: Journey | null) => void;
  /** Returns the active journey to a child context that requests it. */
  onJourneyRequest: () => Journey | null;
  /** Runs when two windows use the same tab identifier. */
  onTabConflict: () => void;
  /**
   * Runs this context's own flush for a child that asked, with the child's time limit. Without
   * it, the bus answers no flush request.
   * @param timeoutMs How long the flush waits, in milliseconds, already in range.
   * @returns The flush result.
   */
  onFlush?: (timeoutMs: number) => Promise<FlushResult>;
  /** The runtime's slot for the remote sampling rules. The bus both reads and fills it. */
  remote: RemoteSlot;
}

/** Link types that a sender context may claim ownership over during handshakes. */
const OWNED: readonly LinkKind[] = ["children", "direct", "worker"];

/** Journey scope after the bus resolves "auto". */
type ResolvedScope = Exclude<JourneyScope, "auto">;

/** A child's flush request that waits for the next flush. */
interface FlushWait {
  /** The physical source, or its link when the link names none. Its cap counts on it. */
  source: unknown;
  /** Epoch time in milliseconds when the child stops waiting. */
  ends: number;
  /** Sends the result to the child that asked. */
  answer: (result: FlushResult) => void;
}

/** Coordinates cross-realm communication, role resolution, and message dispatch. */
export class Bus {
  /** Window and worker registrations with their permissions. */
  private readonly sources = new Map<object, SourceOptions & { origin?: string }>();
  /** Message counts for each window and worker in the current rate window. */
  private readonly rates = new WeakMap<object, { start: number; count: number }>();
  /** Message counts for each named source or link in the current rate window. */
  private readonly channelRates = new Map<string, { start: number; count: number }>();
  /** Each same-origin direct child's reply. Held weakly so a navigated frame can be freed. */
  private readonly directReplies = new Map<Window, WeakRef<Receive>>();

  /**
   * Checks whether this source may receive a control message. A window can read a message
   * even when it is addressed to another window.
   * @param message Control message to send.
   * @param peer Window or worker that receives the message.
   * @returns True if the source has the required permission.
   */
  private mayPost(message: BusMessage, peer: object): boolean {
    const permissions = this.sources.get(peer)?.permissions;
    if (!permissions) {
      return this.config.bus.sourcePolicy === "trusted-origin";
    }
    if (message.t === BUS_TYPE.journey) {
      return permissions.includes("journey:read");
    }
    if (message.t === BUS_TYPE.journeyRequest) {
      return permissions.includes("journey:write");
    }
    if (message.t === BUS_TYPE.sampling) {
      return permissions.includes("sampling:read");
    }
    return true;
  }

  /**
   * Registers one child window and its permissions.
   * @param frame Frame element or window to register.
   * @param options Expected origin and source permissions.
   * @returns Function that removes this registration.
   */
  registerFrame(frame: HTMLIFrameElement | Window, options: FrameOptions): () => void {
    // Use instanceof here, because the "in" operator throws on a cross-origin window.
    const element = typeof HTMLIFrameElement === "undefined" ? undefined : HTMLIFrameElement;
    const source = element && frame instanceof element ? frame.contentWindow : frame;
    if (!source || new URL(options.origin).origin !== options.origin || options.origin === "null") {
      throw new Error("A frame registration requires a window and an exact origin.");
    }
    const registration = { ...options, permissions: [...(options.permissions ?? ["records"])] };
    this.sources.set(source, registration);
    this.ensureChildrenLink();
    return () => {
      if (this.sources.get(source) === registration) {
        this.sources.delete(source);
      }
    };
  }

  /**
   * Checks if a source is permitted at the given origin.
   * @param source Window or port that sent the message.
   * @param origin Origin supplied by the transport.
   * @returns True if the current source policy permits this source.
   */
  isRegistered(source: object | null, origin: string): boolean {
    if (!source) {
      return false;
    }
    const registration = this.sources.get(source);
    // A registration is bound to its exact origin under every policy, so it needs no
    // trustedOrigins entry.
    if (registration) {
      return registration.origin === origin;
    }
    if (this.config.bus.sourcePolicy === "registered") {
      return false;
    }
    // A srcdoc parent's location.origin reads "null", and its same-origin children would then
    // need a trustedOrigins entry for the page's own origin.
    return (
      origin !== "null" &&
      (origin === frameOrigin() || this.config.bus.trustedOrigins.includes(origin))
    );
  }

  /**
   * Sends the new context id to child frames, workers and OpenFin views. Other tabs keep their
   * own context.
   */
  rotateContext(): void {
    // Only the owner sends on the OpenFin link. Without this message every view keeps the old id.
    this.passContext(this.role === "sender");
  }

  /**
   * Switches to the tab id that the runtime made after a clash. Without it, the next claim,
   * hello and comparison use the old id.
   * @param tabId The new tab id.
   */
  setTabId(tabId: string): void {
    this.tabId = tabId;
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
    this.postToDirectChildren(message);
    if (openFin) {
      this.postOver("openfin", message);
    }
  }

  /**
   * Sends a security context message to every same-origin child on the direct link, dropping
   * any child that is closed, freed or no longer permitted.
   * @param message Security context message.
   */
  private postToDirectChildren(message: BusMessage): void {
    // A direct child runs on this document's origin. In a srcdoc parent, location.origin reads
    // "null", and without the real origin every child would miss the new id.
    const origin = frameOrigin();

    for (const [peer, ref] of this.directReplies) {
      const reply = ref.deref();
      if (!reply || peer.closed || !this.isRegistered(peer, origin)) {
        this.directReplies.delete(peer);
        continue;
      }

      this.diagnostics.guard("bus.send_failed", "The reply to a direct child failed.", () => {
        reply(message, { link: "direct", origin: "same-origin", peer });
      });
    }
  }

  /**
   * Keeps a direct child's reply callback for the next context id. Closed children are dropped
   * along the way, so a removed frame doesn't keep its document in memory.
   * @param peer The child's window.
   * @param reply The child's reply callback.
   */
  private keepDirectReply(peer: Window, reply: Receive): void {
    for (const known of this.directReplies.keys()) {
      if (known.closed) {
        this.directReplies.delete(known);
      }
    }

    this.directReplies.set(peer, new WeakRef(reply));
  }

  /** Current bus role. Defaults to "sender". */
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
  /** True after destroy(), so a handshake that finishes later doesn't start a timer. */
  private destroyed = false;
  /** Context id of the owner that answered the handshake. Null if there was no handshake. */
  private ownerId: string | null = null;
  /** The owner's transport identity, taken from the handshake. */
  private ownerPeer?: object | string;
  /** Active handshake state awaiting welcome response. */
  private awaitingWelcome: {
    link: LinkKind;
    settle: (ok: boolean) => void;
  } | null = null;
  /** This forwarder's flush requests that wait for an answer, by request id. */
  private readonly flushAnswers = new Map<string, (result: FlushResult) => void>();
  /** Children's flush requests that wait for the flush after the one that runs. */
  private flushQueue: FlushWait[] = [];
  /** True while a flush that a child asked for runs, or waits for its gap. */
  private flushing = false;
  /** Epoch time in milliseconds when the last flush for a child started. */
  private flushedAt = 0;
  /**
   * The document's performance.timeOrigin, read once so each claim and comparison uses one
   * value. Undefined when the browser gives no finite number.
   */
  private readonly since: number | undefined;

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
    private tabId: string,
    private readonly handlers: BusHandlers,
    private readonly handshakeOptions: HandshakeOptions = HANDSHAKE_OPTIONS,
  ) {
    const origin = performance.timeOrigin;
    this.since = Number.isFinite(origin) ? origin : undefined;
  }

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
      // The OpenFin link stays open for control messages.
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
   * @returns How many records went upstream. A record above the size limit doesn't go.
   */
  sendRecords(records: LogRecord[]): number {
    const { maxRecordsPerMessage, maxMessageBytes } = this.config.bus;
    const encoder = new TextEncoder();
    const size = (value: unknown): number =>
      maxMessageBytes === null ? 0 : encoder.encode(JSON.stringify(value)).length;
    const message = (chunk: LogRecord[]): BusMessage => ({
      t: BUS_TYPE.records,
      from: this.contextId,
      records: chunk,
      routingContextId: this.config.securityContext.id || undefined,
    });

    // Measure every record once. A message is the empty envelope plus its records and the
    // commas between them.
    const envelope = size(message([]));
    let chunk: LogRecord[] = [];
    let bytes = envelope;
    let rejected = 0;

    for (const record of records) {
      const recordBytes = size(record);
      if (maxMessageBytes !== null && envelope + recordBytes > maxMessageBytes) {
        this.diagnostics.count("bus.rejected_message");
        rejected++;
        continue;
      }

      const comma = chunk.length > 0 ? 1 : 0;
      if (
        (maxRecordsPerMessage !== null && chunk.length >= maxRecordsPerMessage) ||
        (maxMessageBytes !== null && bytes + comma + recordBytes > maxMessageBytes)
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

    return this.upstream ? records.length - rejected : 0;
  }

  /**
   * Asks the upstream sender to flush, then waits for its answer. The records that went before
   * the request on the same link are in the sender's snapshot, because a link keeps its order.
   * @param timeoutMs The time this context has left, in milliseconds. The sender uses it as its
   * own limit.
   * @param expired Resolves when this context stops waiting.
   * @returns The sender's result, or null when no valid answer came in time.
   */
  async requestFlush(timeoutMs: number, expired: Promise<void>): Promise<FlushResult | null> {
    const { upstream } = this;
    if (!upstream) {
      return null;
    }

    const id = newId(this.diagnostics);
    let settle!: (result: FlushResult) => void;
    const answered = new Promise<FlushResult>((resolve) => {
      settle = resolve;
    });
    this.flushAnswers.set(id, settle);
    upstream.post({ t: BUS_TYPE.flushRequest, from: this.contextId, id, timeoutMs });

    try {
      return await Promise.race([answered, expired.then(() => null)]);
    } finally {
      this.flushAnswers.delete(id);
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
    if (!this.acceptsMessage(message, source, true)) {
      return;
    }
    if (message.from === this.contextId) {
      return;
    }

    // A rotation sends the new id through this reply, so the child doesn't send a stale batch.
    if (peer) {
      this.keepDirectReply(peer, reply);
    }

    // A direct link has no channel from parent to child, so the parent answers here. The
    // forwarder rule in routeMessage() would refuse a sampling question on a direct link.
    if (message.t === BUS_TYPE.samplingRequest) {
      reply(this.rulesAnswer(message.from), plain);
      return;
    }
    // While this context still waits for its own owner it has no final id, so it sends none.
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
    // An answer goes to this worker only. Over postOver() it would reach every attached worker.
    const receive: Receive = (message, source) => {
      this.receive(message, {
        ...source,
        reply: (answer) => {
          link.post(answer);
        },
      });
    };
    const raw = createWorkerLink(worker, receive, this.diagnostics);
    const link: Link = {
      ...raw,
      post: (message) => {
        if (this.mayPost(message, worker)) {
          raw.post(message);
        }
      },
    };
    this.links.push(link);
    return () => {
      link.close();
      const index = this.links.indexOf(link);
      if (index >= 0) {
        this.links.splice(index, 1);
      }
      if (this.sources.get(worker) === registration) {
        this.sources.delete(worker);
      }
    };
  }

  /**
   * Sends journey state changes over every link in the journey scope.
   * @param journey Active journey or null if ended.
   */
  broadcastJourney(journey: Journey | null): void {
    this.postJourney({ t: BUS_TYPE.journey, from: this.contextId, journey });
  }

  /** Closes all open links and clears internal state. */
  destroy(): void {
    this.sources.clear();
    this.directReplies.clear();
    this.flushQueue = [];
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

  /** Sends a journey message over every link in the journey scope. */
  private postJourney(message: BusMessage): void {
    for (const link of this.allLinks()) {
      if (this.journeyLink(link.kind)) {
        link.post(message);
      }
    }
  }

  /** Routes incoming messages to registered handlers or upstream targets. */
  private readonly receive = (message: BusMessage, source: MessageSource): void => {
    // Anything arriving here on the direct link is an answer from the parent, because
    // acceptDirect() handles a direct child's messages. That leaves only the children and worker
    // links carrying child traffic.
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

    let verdict: boolean | "journey_denied";
    try {
      verdict = this.passesChecks(message, source, child);
    } catch {
      // Either a value JSON can't encode or a non-finite number fails the checks.
      // The count below reports the rejection.
      verdict = false;
    }

    if (verdict === "journey_denied") {
      this.diagnostics.count("bus.journey_denied");
      return false;
    }
    if (!verdict) {
      this.diagnostics.count("bus.rejected_message");
    }
    return verdict;
  }

  /**
   * Runs the source, budget, shape and permission checks. A failed check returns false instead
   * of throwing, so a flood of rejected messages builds no stack traces. Only the JSON encoding
   * can throw, and acceptsMessage catches that.
   * @param message Message from the source.
   * @param source Link and identity of the source.
   * @param child True if the source is a child of this context.
   * @returns True if the message passes every check, or "journey_denied" for a journey request
   * from a registered source without journey:read.
   */
  private passesChecks(
    message: BusMessage,
    source: MessageSource,
    child: boolean,
  ): boolean | "journey_denied" {
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
      if (this.channelRates.size >= BUS_MAX_TRACKED_SOURCES && !this.channelRates.has(key)) {
        return false;
      }
      this.channelRates.set(key, rate);
    }

    // With no limit the window still counts, without a cap, so a named source's window stays
    // current.
    if (!countInWindow(rate, bus.maxMessagesPerSecond ?? Infinity, 1000)) {
      return false;
    }

    const encoded = JSON.stringify(message, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("Non-finite value");
      }
      return value;
    });
    if (
      bus.maxMessageBytes !== null &&
      new TextEncoder().encode(encoded).length > bus.maxMessageBytes
    ) {
      return false;
    }
    if (!validMessage(message)) {
      return false;
    }
    if (
      message.t === BUS_TYPE.records &&
      bus.maxRecordsPerMessage !== null &&
      message.records.length > bus.maxRecordsPerMessage
    ) {
      return false;
    }

    if (registration) {
      // A flush request asks for the delivery of records, so it needs the same permission.
      const permission =
        message.t === BUS_TYPE.records || message.t === BUS_TYPE.flushRequest
          ? "records"
          : message.t === BUS_TYPE.journey
            ? "journey:write"
            : message.t === BUS_TYPE.journeyRequest
              ? "journey:read"
              : message.t === BUS_TYPE.samplingRequest
                ? "sampling:read"
                : undefined;
      if (permission && !registration.permissions?.includes(permission)) {
        // Each child asks for the journey when it starts, so this refusal is routine. Counting
        // it as a rejection would make every worker start with default permissions look hostile.
        return permission === "journey:read" ? "journey_denied" : false;
      }
    }

    // Only an upstream owner can publish these control messages.
    if (
      child &&
      (message.t === BUS_TYPE.sampling ||
        message.t === BUS_TYPE.securityContext ||
        message.t === BUS_TYPE.flushResult)
    ) {
      return false;
    }

    // Broadcast reaches each tab on the origin, so no tab may ask the others to flush.
    if (source.link === "broadcast" && message.t === BUS_TYPE.flushRequest) {
      return false;
    }

    // Under the registered policy, broadcast is a control channel only and carries no records.
    return !(
      bus.sourcePolicy === "registered" &&
      source.link === "broadcast" &&
      message.t === BUS_TYPE.records
    );
  }

  /**
   * Hands an accepted message to its handler or to the upstream link.
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
          // While this context still waits for its own owner, its id is only temporary, so send
          // none. announce() sends the final id once the role is known.
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
          // Remember the owner. On a shared link, only the owner may set this context's journey.
          this.ownerId = message.from;
          this.ownerPeer = source.peer;
          const before = this.config.securityContext.id;
          if (
            message.routingContextId &&
            this.handlers.onSecurityContext?.(message.routingContextId) === false
          ) {
            break;
          }
          // Our children may still hold the old id, so pass the owner's id on to them. During a
          // handshake the role can still be "sender", so don't send on the OpenFin link here.
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
        // A paused forwarder takes only the records it would relay, never its owner's traffic.
        if (this.role === "sender" || (this.handlers.paused?.() && this.canRelay(source.link))) {
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
          if (this.handlers.onSecurityContext?.(message.id) !== false) {
            this.rotateContext();
          }
        }
        break;

      case BUS_TYPE.journey:
        if (this.acceptsJourney(message, source)) {
          this.applyJourney(message.journey);
        }
        break;

      case BUS_TYPE.journeyRequest: {
        const current = this.handlers.onJourneyRequest();
        // Address the answer, so that every other context on a shared link ignores it.
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
        // A forwarder answers only its own children, although siblings on its upstream link ask
        // too. Siblings answering each other on OpenFin would mean N squared messages, and a
        // stale copy could win.
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

      case BUS_TYPE.flushRequest:
        // The links that may send records: a sender takes each one, and a forwarder its own
        // children, never a sibling on its upstream link.
        if (this.role === "sender" || this.canRelay(source.link)) {
          this.queueFlush(message, source);
        }
        break;

      case BUS_TYPE.flushResult:
        this.settleFlush(message, source);
        break;

      case BUS_TYPE.tab:
        // Only two different contexts on the broadcast channel can collide.
        if (source.link === "broadcast" && message.tabId === this.tabId) {
          this.settleTabClaim(message);
        }
        break;
    }
  }

  /**
   * Settles another document's claim on this tab id. The older document keeps the id, because
   * window.open and a duplicated tab copy it into the newer one.
   * @param claim The other document's claim on the same tab id.
   */
  private settleTabClaim(claim: Extract<BusMessage, { t: typeof BUS_TYPE.tab }>): void {
    const { since } = claim;

    // An older library sends no since, and equal times can't pick one. The id comparison then
    // picks one of the pair, otherwise both would report the conflict and rename.
    if (since === undefined || this.since === undefined || since === this.since) {
      if (this.contextId > claim.from) {
        this.handlers.onTabConflict();
      }
      return;
    }

    if (since < this.since) {
      this.handlers.onTabConflict();
      return;
    }

    // The claimant started later, so it never heard this document's claim. Claim the id again,
    // so the claimant renames.
    this.postOver("broadcast", this.tabClaim());
  }

  /**
   * Queues a child's flush request. The first request runs its flush alone, and the requests
   * that arrive meanwhile share one flush after it, so a flood has one flush running at most.
   * @param message The request.
   * @param source Link and identity of the child, which gets the answer.
   */
  private queueFlush(
    message: Extract<BusMessage, { t: typeof BUS_TYPE.flushRequest }>,
    source: MessageSource,
  ): void {
    const from = source.peer ?? source.link;
    const own = this.flushQueue.filter((wait) => wait.source === from).length;
    if (
      this.flushQueue.length >= BUS_MAX_FLUSH_REQUESTS ||
      own >= BUS_MAX_FLUSH_REQUESTS_PER_SOURCE
    ) {
      this.diagnostics.count("bus.rejected_message");
      return;
    }

    const timeoutMs = Math.min(Math.max(message.timeoutMs, 0), FLUSH_TIMEOUT_MAX_MS);
    this.flushQueue.push({
      source: from,
      ends: Date.now() + timeoutMs,
      answer: (result) => {
        this.answer(source, {
          t: BUS_TYPE.flushResult,
          from: this.contextId,
          id: message.id,
          result,
        });
      },
    });

    if (!this.flushing) {
      void this.runFlushes();
    }
  }

  /**
   * Runs one flush for the waiting requests, and one more while new requests wait. Two flushes
   * start at least BUS_FLUSH_GAP_MS apart, and a request in the gap joins the next one.
   */
  private async runFlushes(): Promise<void> {
    this.flushing = true;

    try {
      while (this.flushQueue.length > 0) {
        const gap = this.flushedAt + BUS_FLUSH_GAP_MS - Date.now();
        // Wait only when the gap isn't over, so the first request's flush starts at once.
        if (gap > 0) {
          await new Promise<void>((resolve) => {
            unrefTimer(setTimeout(resolve, gap));
          });
        }

        // Only destroy() empties the queue during the gap, and then no child waits for an answer.
        if (this.flushQueue.length === 0) {
          return;
        }

        this.flushedAt = Date.now();
        const waiting = this.flushQueue;
        this.flushQueue = [];
        // The latest end, so a short request doesn't cut the others' wait. The flush still ends
        // once its batches end.
        const ends = Math.max(...waiting.map((wait) => wait.ends));
        const result = await this.diagnostics.guardAsync(
          "pipeline.crashed",
          "The flush that a child context asked for failed. The child gets no answer.",
          async () => this.handlers.onFlush?.(Math.max(0, ends - Date.now())),
        );

        if (result && !this.destroyed) {
          for (const wait of waiting) {
            // A child whose reply throws must not cost the next child its answer.
            this.diagnostics.guard(
              "bus.send_failed",
              "The answer to a flush request failed.",
              () => {
                wait.answer(result);
              },
            );
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Hands a flush answer to the request that waits for it. Only the upstream owner can answer,
   * because a sibling on a shared link can read the request's id.
   * @param message The answer.
   * @param source Link and identity of the sender of the answer.
   */
  private settleFlush(
    message: Extract<BusMessage, { t: typeof BUS_TYPE.flushResult }>,
    source: MessageSource,
  ): void {
    const settle = this.flushAnswers.get(message.id);
    // Each view on the OpenFin link reads each answer, so there the owner's identity must be known.
    const peer =
      this.ownerPeer === undefined ? source.link !== "openfin" : this.ownerPeer === source.peer;
    if (!settle || !peer || !this.fromOwner(message.from, source.link)) {
      return;
    }

    let result: FlushResult | null;
    try {
      result = readFlushResult(message.result);
    } catch {
      // A getter on a same-origin parent's object can throw on this second read.
      result = null;
    }

    if (!result) {
      this.diagnostics.count("bus.rejected_message");
      return;
    }

    settle(result);
  }

  /**
   * Answers whoever sent a message. A link that can address a single source sends to it only.
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
   * Checks whether records from a link can go upstream. Records sent back out on the link
   * they arrived on would return to their sender. A direct link is the exception, because
   * each one is a single call into one parent, so two direct links in a chain are
   * different links.
   * @param link Kind of the link the records arrived on.
   * @returns True if the relay is safe.
   */
  private canRelay(link: LinkKind): boolean {
    return link === "direct" || link !== this.upstream?.kind;
  }

  /** Checks whether this context can own the given link type. */
  private canOwn(link: LinkKind): boolean {
    // A forwarder that knows its owner also owns its own children and relays their records
    // upstream.
    const owner = this.role === "sender" || this.ownerId !== null;
    if (!owner) {
      return false;
    }
    if (link === "openfin") {
      return this.role === "sender" && this.isOpenFinProvider;
    }
    return OWNED.includes(link);
  }

  /** Works out whether this context is the OpenFin platform provider. */
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

  /** Checks whether a cross-origin boundary blocks access to the parent window. */
  private isCrossOriginFrame(): boolean {
    if (typeof window === "undefined" || window.parent === window) {
      return false;
    }
    try {
      // A cross-origin parent throws on this read. It goes through Reflect.get because lint
      // rejects a bare property read.
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

    if (!this.platform.isWorker) {
      this.ensureChildrenLink();
    }
    if (this.platform.isTopLevelDocument) {
      push(createBroadcastLink(BUS_CHANNEL_NAME, this.receive, this.diagnostics));
    }
    if (this.platform.platform === "openfin" || this.platform.platform === "openfin_web") {
      push(this.ensureOpenFinLink());
    }
  }

  /** Opens the link to child frames if it is not already open. */
  private ensureChildrenLink(): void {
    if (this.links.some((link) => link.kind === "children")) {
      return;
    }
    const link = createChildrenLink(
      this.receive,
      this.config.bus.trustedOrigins,
      this.diagnostics,
      (source, origin) => {
        const accepted = this.isRegistered(source, origin);
        if (!accepted) {
          this.diagnostics.count("bus.rejected_message");
          // A registered window speaking from another origin is untrusted too. Without this
          // report, a registration with the wrong origin silences the frame with no named cause.
          const registered = source !== null && this.sources.has(source);
          const trusted =
            origin === frameOrigin() || this.config.bus.trustedOrigins.includes(origin);
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
    if (link) {
      this.links.push(link);
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
   * Runs a hello/welcome handshake over the candidate link.
   * @param candidate Upstream link candidate.
   * @returns True if the welcome arrived before the timeout.
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
      // finish reads timer, which is declared after it. That's safe, because finish can only
      // run after the post below, and by then the timer exists.
      const timer = setTimeout(() => {
        finish(false);
      }, this.handshakeOptions.timeoutMs);
      unrefTimer(timer);
      candidate.post({ t: BUS_TYPE.hello, from: this.contextId, tabId: this.tabId });
    });
  }

  /**
   * Builds this context's tab claim. An unknown start time stays out of the claim, so the
   * receiver falls back to the id comparison.
   * @returns The claim.
   */
  private tabClaim(): BusMessage {
    return {
      t: BUS_TYPE.tab,
      from: this.contextId,
      tabId: this.tabId,
      ...(this.since === undefined ? {} : { since: this.since }),
    };
  }

  /** Broadcasts tab claim and queries existing journey state. */
  private announce(): void {
    this.postOver("broadcast", this.tabClaim());
    if (this.upstream && this.ownerId === null) {
      this.upstream.post({ t: BUS_TYPE.hello, from: this.contextId, tabId: this.tabId });
    }
    this.postJourney({ t: BUS_TYPE.journeyRequest, from: this.contextId });
    this.pollRules();
    // The role is final now. Children welcomed during the handshake got no id, so send it now.
    this.passContext(false);
  }

  /**
   * Resolves the journey scope. "auto" becomes "origin" in OpenFin and "tab" in a browser.
   * @returns The scope in effect.
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
   * Checks whether a link carries journey messages in the current scope.
   * Only "origin" uses the broadcast link, which reaches every tab on the origin.
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
   * Checks whether this context adopts a journey message.
   * @param message Journey message.
   * @param source Link and origin of the message.
   * @returns True for a message on a journey link, addressed to this context, from an accepted
   * sender. In "tab" scope, the only accepted sender is a forwarder's owner.
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
   * Checks whether a message comes from this forwarder's upstream owner.
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
   * Parses a journey payload from another realm and hands it to the runtime.
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
   * Builds the answer to a sampling question. Null rules clear the forwarder's copy.
   * @param to Context id of the forwarder that asked.
   * @returns The answer.
   */
  private rulesAnswer(to: string): BusMessage {
    const rules = this.handlers.remote.sampling?.wire() ?? null;

    return { t: BUS_TYPE.sampling, from: this.contextId, to, rules };
  }

  /**
   * Checks whether this context accepts sampling rules from a source.
   * @param to Context id that the answer names.
   * @param source Link and origin of the answer.
   * @returns True only for an answer from the upstream owner to this context.
   */
  private acceptsRules(to: string, source: MessageSource): boolean {
    // Accept rules only from the upstream owner. A sibling on a shared link isn't trusted.
    if (this.role !== "forwarder" || to !== this.contextId || source.link !== this.upstream?.kind) {
      return false;
    }

    // A page on another origin can embed this app. Don't let it lower minLevel and read the
    // records. A srcdoc frame's location.origin reads "null", so compare with its real origin,
    // as the parent link does.
    const { origin } = source;

    if (
      source.link === "parent" &&
      origin !== frameOrigin() &&
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
   * Applies the rules from an answer, ignoring any that are invalid.
   * @param raw The answer's rules, or null when the upstream has none.
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
   * Asks the upstream owner for the remote sampling rules now, then on every poll interval.
   * A direct link can't push the rules to a child, but a poll works on every link kind.
   */
  private pollRules(): void {
    const { upstream } = this;

    if (this.destroyed || this.role !== "forwarder" || !upstream) {
      return;
    }

    // Read the config on every poll, because a later configure() can turn remote sampling on
    // or off.
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
