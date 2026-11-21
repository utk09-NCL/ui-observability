// src/api/client.ts
//
// A small client for the mock app API. It uses the global fetch with a relative URL, so the
// library's fetch capture records each call and adds a traceparent header to it, because
// capture.propagateTraceHeaderTo has a pattern for /api/.

import type { FaultMode, LoginResult, NewOrder, Order, Position, Tenant } from "./types";

/** An answer that isn't 2xx. `status` is the HTTP status. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** The part of the client that placeOrder() needs, so a test can pass a fake. */
export interface OrderApi {
  placeOrder(order: NewOrder): Promise<Order>;
}

export interface Api extends OrderApi {
  login(user: string, tenant: string): Promise<LoginResult>;
  logout(): Promise<void>;
  /**
   * Revokes the current token while the page closes. The request has keepalive, so the browser
   * sends it after the page is gone. It returns at once and throws nothing.
   */
  logoutOnExit(): void;
  /** Asks for a new token for the same session. The old token ends. */
  refresh(): Promise<LoginResult>;
  /** Revokes a token other than the current one, for example the token of the old tenant. */
  logoutToken(token: string): Promise<void>;
  tenants(): Promise<Tenant[]>;
  listOrders(): Promise<Order[]>;
  positions(): Promise<Position[]>;
  cancelOrder(id: string): Promise<Order>;
  getFault(): Promise<FaultMode>;
  setFault(mode: FaultMode): Promise<FaultMode>;
}

/** Reads the error text of an answer, or the status line when the body has none. */
async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };

    return typeof body.error === "string" ? body.error : response.statusText;
  } catch {
    // The body isn't JSON, so the status line is all there is.
    return response.statusText;
  }
}

/**
 * Creates the client.
 * @param getToken Returns the token of the logged-in user, or undefined before the login.
 * @returns The client.
 */
export function createApi(getToken: () => string | undefined): Api {
  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    tokenOverride?: string,
  ): Promise<T> => {
    const token = tokenOverride ?? getToken();
    const response = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new ApiError(response.status, await errorText(response));
    }

    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  };

  return {
    login: (user, tenant) => request("POST", "/api/login", { user, tenant }),
    logout: () => request("POST", "/api/logout"),
    refresh: () => request("POST", "/api/refresh"),
    logoutToken: (token) => request("POST", "/api/logout", undefined, token),
    logoutOnExit: () => {
      const token = getToken();
      if (token === undefined) {
        return;
      }

      // The page is closing, so nobody can read the answer. A failed request leaves a token that
      // expires on its own.
      fetch("/api/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true,
      }).catch(() => undefined);
    },
    tenants: () => request("GET", "/api/tenants"),
    listOrders: () => request("GET", "/api/orders"),
    positions: () => request("GET", "/api/positions"),
    placeOrder: (order) => request("POST", "/api/orders", order),
    cancelOrder: (id) => request("DELETE", `/api/orders/${encodeURIComponent(id)}`),
    getFault: async () => (await request<{ mode: FaultMode }>("GET", "/api/__fault")).mode,
    setFault: async (mode) =>
      (await request<{ mode: FaultMode }>("POST", `/api/__fault?mode=${mode}`)).mode,
  };
}
