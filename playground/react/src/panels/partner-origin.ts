// src/panels/partner-origin.ts
//
// The origin of the cross-origin widgets, the Partner widget and the Untrusted widget. The pages
// come from the server of `pnpm run dev:cross-origin`, on port 5174. The smoke test sets another
// origin, so it runs its own copy of that server.

export const PARTNER_ORIGIN = String(
  import.meta.env.VITE_PARTNER_ORIGIN ?? "http://localhost:5174",
);
