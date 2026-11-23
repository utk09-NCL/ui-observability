// src/utils/openfin.ts
//
// Reads the optional OpenFin runtime API without importing an OpenFin package. The types
// list only the members that the library reads. Every member is optional, because a test, an
// older runtime or OpenFin web can leave it out.

/** The InterApplicationBus operations that the bus link uses. */
export interface FinIab {
  /**
   * Subscribes a listener to a topic for matching application identities.
   * @param identity Target application identity.
   * @param topic Topic name.
   * @param listener Message callback.
   */
  subscribe(
    identity: { uuid: string },
    topic: string,
    listener: (message: unknown, uuid?: string, name?: string) => void,
  ): Promise<void>;

  /**
   * Sends a message to the topic subscribers of one application.
   * @param destination Target application identity.
   * @param topic Topic name.
   * @param message Message payload.
   */
  send(destination: { uuid: string }, topic: string, message: unknown): Promise<void>;

  /**
   * Removes a listener that subscribe() added. An older runtime may not have it.
   * @param identity The identity that subscribe() got.
   * @param topic The topic that subscribe() got.
   * @param listener The listener that subscribe() got.
   */
  unsubscribe?(
    identity: { uuid: string },
    topic: string,
    listener: (message: unknown, uuid?: string, name?: string) => void,
  ): Promise<void>;
}

/** The fin.me members that the library reads. */
export interface FinMe {
  /** True in an OpenFin view. */
  isView?: boolean;
  /** Identity of the window or view. */
  identity?: { uuid?: string; name?: string };
  /** Resolves the window's creation options, including customData. */
  getOptions?: () => Promise<{ customData?: Record<string, unknown> }>;
  /** Adds a window event listener. */
  on?: (event: string, listener: () => void) => void;
  /** Removes a window event listener. */
  removeListener?: (event: string, listener: () => void) => void;
}

/** The members of the OpenFin global that the library reads. */
export interface FinLike {
  /** This document's window or view. */
  me?: FinMe;
  /** The OpenFin runtime's message bus. */
  InterApplicationBus?: FinIab;
}

/**
 * Returns the OpenFin global.
 * @returns The fin global, or undefined outside OpenFin.
 */
export function getFin(): FinLike | undefined {
  return (globalThis as { fin?: FinLike }).fin;
}
