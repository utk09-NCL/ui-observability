// src/utils/openfin.ts
//
// Reads the optional OpenFin runtime API. The library does not import an OpenFin package. The
// types list only the members that the library reads. Each member is optional, because a test, an
// older runtime or OpenFin web can leave it out.

/** The InterApplicationBus operations that the bus link uses. */
export interface FinIab {
  /**
   * Publishes a message to all topic subscribers.
   * @param topic Topic name.
   * @param message Message payload.
   */
  publish(topic: string, message: unknown): Promise<void>;

  /**
   * Subscribes a listener to a topic for matching application identities.
   * @param identity Target application identity.
   * @param topic Topic name.
   * @param listener Message callback.
   */
  subscribe(
    identity: { uuid: string },
    topic: string,
    listener: (message: unknown) => void,
  ): Promise<void>;
}

/** The members of fin.me that the library reads. */
export interface FinMe {
  /** True in an OpenFin view. */
  isView?: boolean;
  /** Identity of the window or view. */
  identity?: { uuid?: string; name?: string };
  /** Resolves the creation options of the window, with customData. */
  getOptions?: () => Promise<{ customData?: Record<string, unknown> }>;
  /** Adds a window event listener. */
  on?: (event: string, listener: () => void) => void;
  /** Removes a window event listener. */
  removeListener?: (event: string, listener: () => void) => void;
}

/** The members of the OpenFin global that the library reads. */
export interface FinLike {
  /** The window or view of this document. */
  me?: FinMe;
  /** The message bus of the OpenFin runtime. */
  InterApplicationBus?: FinIab;
}

/**
 * Gives the OpenFin global.
 * @returns The fin global, or undefined outside OpenFin.
 */
export function getFin(): FinLike | undefined {
  return (globalThis as { fin?: FinLike }).fin;
}
