// src/observability/auth-headers.ts
//
// The headers function of the library. It reads the current token on each request, so a token
// refresh needs no configure() call. The function must stay one reference, because configure()
// counts a function as the same setting only when it is the same reference.

import { getToken } from "../session/token";

/**
 * Returns the Authorization header of the logged-in user, or no header before the login.
 * @returns Request headers for the log backend.
 */
export function authHeaders(): Record<string, string> {
  const token = getToken();

  return token ? { Authorization: `Bearer ${token}` } : {};
}
