// src/workspace/user-menu.tsx
//
// The user menu: switch tenant, privacy choices, log out, and log out on a shared device. The
// four actions follow the recipes of docs/production-recipes.md. The caller runs them.

import type { ReactElement } from "react";
import type { Tenant } from "../api/types";
import { MenuButton } from "./menu";

export interface UserMenuProps {
  user: string;
  tenant: string;
  tenants: readonly Tenant[];
  /** True while a login, a logout, a restart or a change of setting runs. */
  busy: boolean;
  onSwitchTenant: (tenant: string) => void;
  onPrivacy: () => void;
  onLogout: () => void;
  onLogoutShared: () => void;
}

/**
 * Renders the menu button and the menu.
 * @param props The user, the tenants and the actions.
 * @returns The menu.
 */
export function UserMenu(props: UserMenuProps): ReactElement {
  const { user, tenant, tenants, busy } = props;
  const current = tenants.find((item) => item.id === tenant);

  return (
    <MenuButton
      label={`${user}, ${current?.name ?? tenant} ▾`}
      action="user-menu"
      menuLabel="User menu"
    >
      {(close) => (
        <>
          <p className="menu-heading muted">Switch tenant</p>
          {tenants
            .filter((item) => item.id !== tenant)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={busy}
                data-observability-action="switch-tenant"
                onClick={() => {
                  close();
                  props.onSwitchTenant(item.id);
                }}
              >
                {item.name}
              </button>
            ))}
          <hr />
          <button
            type="button"
            role="menuitem"
            data-observability-action="privacy-choices"
            onClick={() => {
              close();
              props.onPrivacy();
            }}
          >
            Privacy choices
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            data-observability-action="logout"
            onClick={() => {
              close();
              props.onLogout();
            }}
          >
            Log out
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            title="Discards the unsent records, removes the stored data of the library and the saved layouts of this user."
            data-observability-action="logout-shared"
            onClick={() => {
              close();
              props.onLogoutShared();
            }}
          >
            Log out on a shared device
          </button>
        </>
      )}
    </MenuButton>
  );
}
