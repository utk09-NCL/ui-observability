// src/workspace/login-screen.tsx
//
// The login screen. Any user name works, because the API is a mock.

import { type ReactElement, type SyntheticEvent, useEffect, useState } from "react";
import type { Api } from "../api/client";
import type { Tenant } from "../api/types";
import { useBusy } from "../observability-settings/operation-queue";

/**
 * Renders the login form.
 * @param props The API client, which lists the tenants, the login callback and a notice.
 * @returns The form.
 */
export function LoginScreen({
  api,
  onLogin,
  notice,
}: {
  api: Pick<Api, "tenants">;
  onLogin: (user: string, tenant: string) => Promise<void>;
  /** A message from the last session, for example why the app returned to the login screen. */
  notice: string;
}): ReactElement {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [user, setUser] = useState("trader1");
  const [tenant, setTenant] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Also true while a restart or another operation runs.
  const busy = useBusy() || submitting;

  useEffect(() => {
    let active = true;
    api
      .tenants()
      .then((list) => {
        if (active) {
          setTenants(list);
          setTenant(list[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (active) {
          setError("The mock app API is not reachable. Start it with pnpm run dev:app-api.");
        }
      });

    return () => {
      active = false;
    };
  }, [api]);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await onLogin(user.trim(), tenant);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The login failed.");
      setSubmitting(false);
    }
  };

  return (
    <main className="login">
      <h1>FX workspace</h1>
      <form
        className="card"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="field">
          <label htmlFor="login-user">User name</label>
          <input
            id="login-user"
            value={user}
            required
            maxLength={64}
            autoComplete="username"
            onChange={(event) => {
              setUser(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="login-tenant">Tenant</label>
          <select
            id="login-tenant"
            value={tenant}
            onChange={(event) => {
              setTenant(event.target.value);
            }}
          >
            {tenants.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={busy || tenant === ""} data-observability-action="login">
          Log in
        </button>
        <p role="status" className="muted">
          {notice}
        </p>
        <p role="alert" className="warn">
          {error}
        </p>
      </form>
    </main>
  );
}
