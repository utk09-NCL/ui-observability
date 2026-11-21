// src/session/token.ts
//
// The token of the logged-in user, in memory only. A reload shows the login screen again.

let token: string | undefined;

export function getToken(): string | undefined {
  return token;
}

export function setToken(next: string | undefined): void {
  token = next;
}
