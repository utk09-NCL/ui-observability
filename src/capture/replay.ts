// src/capture/replay.ts
//
// Session replay. The app's recorder package records the DOM, and this capture keeps the recent
// events in memory. When an ERROR or FATAL record comes through, it uploads the buffer plus a
// few seconds of what happens next. All text and input values are masked by default.

import { IGNORE_SELECTOR, REPLAY_ID_KEY, REPLAY_UNMASK_ATTRIBUTE } from "../constants";
import type { LogRecord } from "../models/log-record";
import type { ReplayEvent, ReplayPluginTools, ReplayRecord } from "../models/replay";
import { newId } from "../utils/identity";
import { isLibraryRequest } from "../utils/library-request";
import { recordedUrl } from "../utils/platform";
import { unrefTimer } from "../utils/unref";
import { ReplayBuffer } from "./replay-buffer";
import { ReplayUploader } from "./replay-upload";
import { allowInWindow, type StormWindow } from "./storm";
import { type Capture, type CaptureContext, matchesAny } from "./types";

/** Resource attribute for the session id. */
const SESSION_ID = "session.id";

/** Resource attribute for the tab id. */
const TAB_ID = "tab.id";

/** Every non-space character of masked text becomes this. */
const MASK_CHARACTER = "*";

/**
 * The replay.recordOptions keys we pass through to the recorder. Everything else the recorder
 * accepts is a mask, block, canvas, plugin or event option, and those are ours to set.
 */
const RECORD_OPTION_KEYS = [
  "sampling",
  "slimDOMOptions",
  "ignoreClass",
  "ignoreSelector",
  "ignoreCSSAttributes",
  "userTriggeredOnInput",
  "recordAfter",
  "inlineStylesheet",
  "dataURLOptions",
];

/**
 * Per-element input mask for the recorder. We don't use its "mask all inputs" switch because
 * that list leaves out hidden and file inputs.
 */
const MASK_EACH_INPUT = { input: true, textarea: true, select: true };

/** What every masked input value turns into. Fixed length, so it doesn't give away a PIN's. */
const MASKED_INPUT = "********";

/** Class of the detached element that shows whether a selector entry swallows the next one. */
const SELECTOR_PROBE = "uiobs-selector-probe";

/**
 * Checks one selector the way the recorder will use it.
 * @param selector A selector entry or a joined list.
 * @param followed True when another entry comes after it in a list.
 * @returns The fault to report, or undefined for a usable selector.
 */
function selectorFault(selector: string, followed: boolean): unknown {
  try {
    document.createDocumentFragment().querySelector(selector);

    // Chromium closes an open quote or "[" at the end, so '[x="a' parses alone and in a list,
    // but swallows the entries after it. With a probe entry after it, the probe can't match.
    const probe = document.createElement("i");
    probe.className = SELECTOR_PROBE;
    if (followed && !probe.matches(`${selector},.${SELECTOR_PROBE}`)) {
      return new SyntaxError("The selector swallows the entries after it.");
    }

    return undefined;
  } catch (error) {
    // The parser's error goes back to the caller as the report's cause.
    return error;
  }
}

/** Event type of the meta event, which carries the page URL. */
const META_EVENT = 4;

/** Event type of an incremental snapshot. */
const INCREMENTAL_EVENT = 3;

/** Incremental snapshot source for DOM mutations. */
const MUTATION_SOURCE = 0;

/** Node type of a text node in the recorder's serialized nodes. */
const TEXT_NODE = 3;

/** The bits of a recorder event we rewrite before keeping it. */
interface ScrubData {
  /** Page URL, on a meta event. */
  href?: unknown;
  /** Source of an incremental snapshot. */
  source?: unknown;
  /** Text changes in a mutation. */
  texts?: { id: number; value: unknown }[];
  /** Nodes added by a mutation. */
  adds?: { node?: { id: number; type: number; textContent?: unknown } }[];
}

/** Records the DOM and uploads the recent events after an error. */
export class ReplayCapture implements Capture {
  /** Capture module identifier. */
  readonly name = "replay";

  /** Recent events. An upload empties it. */
  private readonly buffer: ReplayBuffer;

  /** Cuts the events into segments and sends them. */
  private readonly uploader: ReplayUploader;

  /** Upload rate limit, so an error storm doesn't upload the page over and over. */
  private readonly window: StormWindow = { start: 0, count: 0 };

  /** The recorder's record function. Undefined while the recorder isn't running. */
  private record: ReplayRecord | undefined;

  /** Stops the recorder. */
  private stopRecorder: (() => void) | undefined;

  /** Id of the current recording. */
  private replayId = "";

  /** True between install() and uninstall(). */
  private installed = false;

  /** True while start() is loading the recorder. */
  private starting = false;

  /** Bumped on every stop, so a start that finishes after a stop records nothing. */
  private generation = 0;

  /** True right after an error, while new events go straight to the uploader. */
  private live = false;

  /** True once we've reported a full snapshot that doesn't fit in the buffer. */
  private starvedReported = false;

  /** Ends the live period after an error. */
  private liveTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param ctx Capture context: configuration, diagnostics and the runtime hooks.
   */
  constructor(private readonly ctx: CaptureContext) {
    this.buffer = new ReplayBuffer(() => this.ctx.config.replay.maxBufferBytes);
    this.uploader = new ReplayUploader(() => this.ctx.config, this.ctx.diagnostics);
  }

  /** Starts listening for error records, and starts the recorder unless consent is still needed. */
  install(): void {
    if (this.installed) {
      return;
    }

    this.installed = true;
    this.ctx.onError?.(this.onError);

    // If the app called stopReplay(), that still holds after the captures are reinstalled.
    if (this.ctx.replayConsent?.() ?? !this.ctx.config.replay.requireConsent) {
      void this.start();
    }
  }

  /** Stops the recorder and drops whatever hasn't been sent. */
  uninstall(): void {
    this.installed = false;
    this.ctx.onError?.(undefined);
    this.stop();
  }

  /**
   * Loads the recorder and starts it. Never rejects.
   * @returns A promise that resolves once the recorder is running, or can't run.
   */
  async start(): Promise<void> {
    const { diagnostics } = this.ctx;
    const { loader, endpoint, onSegment, plugins } = this.ctx.config.replay;

    if (!this.installed || this.record || this.starting) {
      return;
    }

    if (typeof document === "undefined") {
      this.reportOnce("This context has no document. The session replay is off.");
      return;
    }

    if (!loader || (endpoint === null && !onSegment)) {
      diagnostics.report(
        "config.invalid",
        "The session replay needs replay.loader, and replay.endpoint or replay.onSegment. The session replay is off.",
      );
      return;
    }

    const selectors = this.selectors();
    if (!selectors) {
      return;
    }

    const { generation } = this;
    this.starting = true;
    const loaded = await diagnostics.guardAsync(
      "capture.install_failed",
      "The library could not load the replay recorder.",
      loader,
    );
    const tools: ReplayPluginTools = { transformRequest: this.transformRequest };
    const made = await Promise.all(
      plugins.map((make) =>
        diagnostics.guardAsync(
          "capture.install_failed",
          "The library could not load a replay plugin.",
          () => Promise.resolve(make(tools)),
        ),
      ),
    );

    // A stop or an uninstall while we were loading cancels this start.
    if (generation !== this.generation) {
      return;
    }

    this.starting = false;

    // The loader failed, and the guard has already reported it.
    if (!loaded) {
      return;
    }

    const { record } = loaded;
    if (typeof record !== "function") {
      diagnostics.report(
        "capture.install_failed",
        "The replay loader gave no record function. The session replay is off.",
      );
      return;
    }

    const config = this.ctx.config.replay;
    diagnostics.guard("capture.install_failed", "The replay recorder did not start.", () => {
      const extra: Record<string, unknown> = {};
      const ignored: string[] = [];

      for (const [key, value] of Object.entries(config.recordOptions)) {
        if (RECORD_OPTION_KEYS.includes(key)) {
          extra[key] = value;
        } else {
          ignored.push(key);
        }
      }

      if (ignored.length > 0) {
        diagnostics.report(
          "config.invalid",
          `The library ignores these keys of replay.recordOptions: ${ignored.join(", ")}. It sets the mask, block, canvas, plugin and event options itself.`,
        );
      }

      // The real recorder takes its first snapshot inside record(), so a starve report can come
      // before record() returns.
      this.starvedReported = false;

      const stopRecorder = record({
        ...extra,
        emit: this.emit,
        // Take a full snapshot every half window, so the buffer always begins with one.
        checkoutEveryNms: config.bufferMs / 2,
        // The per-element list covers every input type. Passwords are masked no matter what.
        maskAllInputs: false,
        maskInputOptions: config.maskInputs ? MASK_EACH_INPUT : { password: true },
        maskInputFn: this.maskInput,
        maskTextSelector: selectors.mask,
        maskTextFn: this.maskText,
        blockSelector: selectors.block,
        recordCanvas: config.recordCanvas,
        errorHandler: this.onFault,
        plugins: made.filter((plugin) => plugin !== undefined),
      });

      // The recorder swallows errors from its own startup and just returns no stop function.
      if (typeof stopRecorder !== "function") {
        diagnostics.report("capture.install_failed", "The replay recorder did not start.");
        return;
      }

      this.stopRecorder = stopRecorder;
      this.record = record;
      this.replayId = newId(this.ctx.diagnostics);
      this.ctx.setContext?.(REPLAY_ID_KEY, this.replayId);
    });
  }

  /**
   * Drops the buffer and, if the recorder was running, starts a fresh recording. The runtime
   * calls this on a new session, so the next user never gets the previous user's page.
   */
  reset(): void {
    const running = this.record !== undefined || this.starting;

    this.stop();
    if (running) {
      void this.start();
    }
  }

  /** Stops the recorder and drops whatever hasn't been sent. */
  stop(): void {
    const { stopRecorder } = this;

    this.generation++;
    this.starting = false;
    this.record = undefined;
    this.stopRecorder = undefined;
    this.live = false;
    clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    this.buffer.clear();
    this.uploader.stop();

    if (stopRecorder) {
      this.ctx.setContext?.(REPLAY_ID_KEY, undefined);
      this.ctx.diagnostics.guard(
        "capture.install_failed",
        "The replay recorder did not stop.",
        stopRecorder,
      );
    }
  }

  /**
   * Reads the mask and block selectors. An invalid selector aborts the start: a replay with a
   * missing mask would show text the app meant to hide.
   * @returns The selectors for the recorder, or undefined if one of them is invalid.
   */
  private selectors(): { mask: string | undefined; block: string } | undefined {
    const { maskText, maskSelectors, blockSelectors } = this.ctx.config.replay;
    const mask = maskSelectors.length > 0 ? maskSelectors.join(",") : undefined;
    // Click capture skips the ignored regions, so a replay must not show them either. The app
    // can't turn this off.
    const block = [IGNORE_SELECTOR, ...blockSelectors].join(",");

    // An entry can parse alone and still break the joined list, for example an unclosed "[" that
    // Chromium closes at the end. The recorder gets the lists, so a bad one would mask nothing.
    const checks = [...maskSelectors, ...blockSelectors, block];
    if (mask !== undefined) {
      checks.push(mask);
    }
    // The last entry of each list has nothing after it to swallow.
    const followed = [...maskSelectors.slice(0, -1), ...blockSelectors.slice(0, -1)];

    for (const selector of checks) {
      const fault = selectorFault(selector, followed.includes(selector));
      if (fault !== undefined) {
        this.ctx.diagnostics.report(
          "config.invalid",
          `The replay selector ${selector} is not a valid CSS selector. The session replay is off.`,
          undefined,
          fault,
        );
        return undefined;
      }
    }

    return { mask: maskText ? "*" : mask, block };
  }

  /**
   * Masks one piece of page text. The recorder calls this for every text the mask selector
   * matches.
   * @param text The node's text.
   * @param element The element that holds the text, or null.
   * @returns The text to record.
   */
  private readonly maskText = (text: string, element: Element | null): string => {
    const { maskText, maskSelectors } = this.ctx.config.replay;
    const forced = maskSelectors.length > 0 && element?.closest(maskSelectors.join(","));

    // With maskText off, the recorder only calls us for text under a mask selector.
    if (maskText && !forced && element?.closest(`[${REPLAY_UNMASK_ATTRIBUTE}]`)) {
      return text;
    }

    return text.replace(/\S/g, MASK_CHARACTER);
  };

  /**
   * Masks an input value. The result always has the same length.
   * @param text The input's value.
   * @returns The text to record.
   */
  private readonly maskInput = (text: string): string => (text === "" ? "" : MASKED_INPUT);

  /**
   * Strips what the recorder's own masking misses: the page URL's user info and query, and text
   * sitting directly in a shadow root that changed after the snapshot.
   * @param event Recorder event.
   */
  private scrub(event: ReplayEvent): void {
    const { data } = event as { data?: ScrubData };

    if (!data) {
      return;
    }

    if (event.type === META_EVENT) {
      // User info is a credential, and so is a signed URL's query unless fullUrls keeps it.
      if (typeof data.href === "string") {
        data.href = recordedUrl(data.href, this.ctx.config.capture.fullUrls);
      }
      return;
    }

    if (event.type !== INCREMENTAL_EVENT || data.source !== MUTATION_SOURCE) {
      return;
    }

    for (const change of data.texts ?? []) {
      change.value = this.shadowText(change.value, change.id);
    }

    for (const add of data.adds ?? []) {
      if (add.node?.type === TEXT_NODE) {
        // The recorder holds on to this node object, so change a copy.
        add.node = {
          ...add.node,
          textContent: this.shadowText(add.node.textContent, add.node.id),
        };
      }
    }
  }

  /**
   * Masks text that sits directly in a shadow root. The recorder masks it in a full snapshot
   * but not in later mutations.
   * @param text Text from the mutation.
   * @param id The recorder's id for the text node.
   * @returns The text to record.
   */
  private shadowText(text: unknown, id: number): unknown {
    const node = this.record?.mirror?.getNode(id) as Node | null | undefined;

    // Text with an element parent has already been through the recorder's mask function.
    if (typeof text !== "string" || !node || node.parentElement) {
      return text;
    }

    const { maskText, maskSelectors } = this.ctx.config.replay;
    const host = (node.parentNode as ShadowRoot | null)?.host ?? null;

    if (maskText) {
      return this.maskText(text, host);
    }

    return maskSelectors.length > 0 && host?.closest(maskSelectors.join(","))
      ? text.replace(/\S/g, MASK_CHARACTER)
      : text;
  }

  /**
   * Vets a request from the recorder's network plugin.
   * @param request The plugin's request.
   * @returns The request to record, or undefined to skip it.
   */
  private readonly transformRequest: ReplayPluginTools["transformRequest"] = (request) => {
    // The plugin calls this from inside its fetch wrapper, so a throw here could reach the
    // app's request.
    try {
      const { capture } = this.ctx.config;
      const url = request.name;

      // The plugin calls us after the request, outside the library-request scope, so also check
      // the ignore list. It has every library endpoint, including the replay one. Otherwise a
      // recorded upload becomes a new event, which becomes a new upload.
      if (isLibraryRequest() || matchesAny(url, capture.ignoreUrls)) {
        return undefined;
      }

      // User info is a credential, and so is a signed URL's query unless fullUrls keeps it.
      const name = recordedUrl(url, capture.fullUrls);
      return name === url ? request : { ...request, name };
    } catch (error) {
      this.onFault(error);
      return undefined;
    }
  };

  /**
   * Receives one event from the recorder, which calls this from its observers.
   * @param event Recorder event.
   * @param isCheckout True for the events of a new full snapshot.
   */
  private readonly emit = (event: ReplayEvent, isCheckout?: boolean): void => {
    try {
      this.scrub(event);

      // Stringify once: we need the text for the upload and for the size limit anyway.
      const text = JSON.stringify(event);

      if (this.live) {
        this.uploader.push([text]);
        return;
      }

      if (this.buffer.add(text, event.type, isCheckout === true) && !this.starvedReported) {
        this.starvedReported = true;
        this.ctx.diagnostics.report(
          "capture.rate_limited",
          "One part of the replay is above replay.maxBufferBytes. The buffer is empty until the next full snapshot. The replay of an error in that time starts at the error, with no events from before it. Raise the limit, or block a large element with replay.blockSelectors.",
        );
      }
    } catch (error) {
      this.onFault(error);
    }
  };

  /**
   * Reports an error from the recorder, or from serializing an event.
   * @param error What the recorder caught.
   */
  private readonly onFault = (error: unknown): void => {
    this.ctx.diagnostics.report(
      "capture.record_failed",
      "The replay recorder had an error.",
      undefined,
      error,
    );
  };

  /**
   * Starts an upload when an ERROR or FATAL record comes through.
   * @param record The record the runtime emitted.
   */
  private readonly onError = (record: LogRecord): void => {
    const { diagnostics, config } = this.ctx;

    diagnostics.guard("capture.record_failed", "The replay upload did not start.", () => {
      if (!this.record) {
        return;
      }

      const { afterErrorMs, uploadsPerWindow } = config.replay;

      // An error during the live period rides along in the same upload and doesn't extend it.
      // That way a stream of errors can't hold the upload open, and the upload limit still bites.
      if (
        this.live ||
        !allowInWindow(
          this.window,
          uploadsPerWindow,
          diagnostics,
          "replay uploads",
          config.replay.uploadWindowMs,
        )
      ) {
        return;
      }

      const { texts, lost } = this.buffer.take();
      if (lost > 0) {
        diagnostics.report(
          "capture.rate_limited",
          `The replay buffer was above replay.maxBufferBytes. The library dropped ${String(lost)} events.`,
        );
      }

      const { takeFullSnapshot } = this.record;

      // An empty buffer has no full snapshot, and a player can't do anything without one.
      if (texts.length === 0 && !takeFullSnapshot) {
        return;
      }

      this.uploader.begin({
        replayId: this.replayId,
        sessionId: String(record.resource[SESSION_ID]),
        tabId: String(record.resource[TAB_ID]),
      });
      this.live = true;

      if (texts.length === 0) {
        // We're live, so this snapshot goes straight to the uploader. The real recorder throws
        // here before its start, and without the reset the live period would never end.
        const taken = diagnostics.guard(
          "capture.record_failed",
          "The replay recorder did not take a full snapshot. The library sends no replay for this error.",
          () => {
            this.record?.takeFullSnapshot?.(true);
            return true;
          },
        );

        // Nothing went out, so drop what a half-done snapshot left and give the slot back.
        // The uploader's open segment was empty, because live was off until begin().
        if (!taken) {
          this.live = false;
          this.uploader.discardOpen();
          this.window.count = Math.max(0, this.window.count - 1);
          return;
        }
      } else {
        this.uploader.push(texts);
      }

      this.liveTimer = setTimeout(this.endLive, afterErrorMs);
      unrefTimer(this.liveTimer);
    });
  };

  /** Ends the live period. The buffer starts over with a full snapshot. */
  private readonly endLive = (): void => {
    this.liveTimer = undefined;
    this.live = false;
    this.uploader.flush();
    this.ctx.diagnostics.guard(
      "capture.record_failed",
      "The replay recorder did not take a full snapshot.",
      () => {
        this.record?.takeFullSnapshot?.(true);
      },
    );
  };

  /**
   * Reports why the replay is off, once per document.
   * @param message Report text.
   */
  private reportOnce(message: string): void {
    const { once } = this.ctx;

    if (!once.replay) {
      once.replay = true;
      this.ctx.diagnostics.report("capture.install_failed", message);
    }
  }
}
