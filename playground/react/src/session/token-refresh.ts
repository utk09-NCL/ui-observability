// src/session/token-refresh.ts
//
// The timer of the "Token refresh" recipe. It asks for a new token at a part of the life of the
// token, and then again at the same part of the life of the new one. The library needs no call
// for a refresh. Its headers function reads the current token on each request.

/** The part of the life of a token after which the app refreshes it. */
const REFRESH_AT_FRACTION = 0.8;
/** A token that lives less than this still gets a pause, so a bad answer can't make a busy loop. */
const MIN_DELAY_MS = 1000;

export interface TokenRefreshOptions {
  /** Refreshes the token. Returns how long the new token lives, in milliseconds. */
  refresh: () => Promise<number>;
  /** How long the token of the login lives, in milliseconds. */
  expiresInMs: number;
  /** Called when a refresh fails. The timer stops, because the session is probably over. */
  onError: (error: unknown) => void;
}

/**
 * Starts the refresh timer.
 * @param options The refresh function, the life of the first token and the error handler.
 * @returns Function that stops the timer. An answer that comes after it schedules nothing.
 */
export function startTokenRefresh(options: TokenRefreshOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (expiresInMs: number): void => {
    timer = setTimeout(
      () => {
        void run();
      },
      Math.max(MIN_DELAY_MS, expiresInMs * REFRESH_AT_FRACTION),
    );
  };

  const run = async (): Promise<void> => {
    try {
      const next = await options.refresh();
      if (!stopped) {
        schedule(next);
      }
    } catch (error) {
      if (!stopped) {
        options.onError(error);
      }
    }
  };

  schedule(options.expiresInMs);

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
