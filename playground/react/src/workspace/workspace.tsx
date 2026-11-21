// src/workspace/workspace.tsx
//
// The page after the login: the top bar and the dockview layout. It opens the saved layout of
// the user and the tenant, saves each change, and owns the data of the page. One WebSocket feeds
// the prices and the order updates for every panel.

import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewWillDropEvent,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { getLogger } from "@utk09/ui-observability";
import type { Api } from "../api/client";
import type { Tenant } from "../api/types";
import { useBusy } from "../observability-settings/operation-queue";
import { PANEL_COMPONENTS } from "../panels/registry";
import { refreshSession, type Session } from "../session/session";
import { WorkspaceContext } from "./context";
import { useTokenRefresh, useWorkspaceData } from "./use-workspace-data";
import { addDefaultPanels, openPanel, PANELS } from "./default-layout";
import { HeaderActions } from "./header-actions";
import {
  createLayoutSaver,
  type LayoutSaver,
  readLayout,
  restoreLayout,
  writeLayout,
} from "./layout-store";
import { isFramePanel, movesFrameIntoPopout } from "./frame-panels";
import { MenuButton } from "./menu";
import { closePanelWindows } from "./panel-windows";
import { PrivacyDialog } from "./privacy-dialog";
import { applyTheme, loadTheme, THEMES, type ThemeName } from "./theme";
import { UserMenu } from "./user-menu";
import { Watermark } from "./watermark";

const log = getLogger("workspace.layout");

const TAB_CONTEXT_MENU = [
  "close",
  "closeOthers",
  "closeAll",
  "separator",
  "maximize",
  "float",
  "popout",
] as const;

/**
 * Blocks the drop of a frame panel into a popout window. dockview lets a user drag a tab from the
 * page into an open popout window, and the drop moves the panel there. The browser then loads
 * the iframe again, and its runtime finds no owner.
 * @param event The drop event of dockview, before it moves anything.
 */
function blockFrameDrop(event: DockviewWillDropEvent): void {
  const data = event.getData();
  const dragged = data?.panelId
    ? [event.api.getPanel(data.panelId)]
    : (event.api.getGroup(data?.groupId ?? "")?.panels ?? []);
  const target = event.nativeEvent.target;
  const blocked = movesFrameIntoPopout({
    targetGroup: event.group,
    overPopoutDocument: target instanceof Node && target.ownerDocument !== document,
    dragged: dragged.filter((panel) => panel !== undefined),
  });
  if (blocked) {
    event.preventDefault();
    log.warn("A panel with a frame can't move into a popout window.");
  }
}

/**
 * Renders the workspace of a logged-in user.
 * @param props The session, the API client and the account actions.
 * @returns The workspace.
 */
export function Workspace({
  session,
  api,
  onSwitchTenant,
  onLogout,
  onLogoutShared,
}: {
  session: Session;
  api: Api;
  onSwitchTenant: (tenant: string) => void;
  onLogout: () => void;
  onLogoutShared: () => void;
}): ReactElement {
  const { user, tenant } = session;
  const [theme, setTheme] = useState<ThemeName>(loadTheme);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [notice, setNotice] = useState("");
  // The dockview instance, set by onReady. dockview-react keeps its instance when StrictMode
  // runs the cleanup of a mount, so onReady runs one time for each instance. State, and not a
  // subscription in onReady, lets the effects below start and stop together with the component.
  const [dock, setDock] = useState<DockviewApi | null>(null);
  const saver = useRef<LayoutSaver | null>(null);
  const busy = useBusy();
  const context = useMemo(() => ({ api, session }), [api, session]);

  useWorkspaceData(session, api);
  useTokenRefresh(session, api);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    let active = true;
    api
      .tenants()
      .then((list) => {
        if (active) {
          setTenants(list);
        }
      })
      .catch((error: unknown) => {
        log.error("tenant list failed", error);
      });

    return () => {
      active = false;
    };
  }, [api]);

  // The saver writes after a short quiet time. Dockview fires many change events during a drag.
  // The cleanup stops the listeners and the saver, so a StrictMode remount starts them again
  // and a real unmount can't write a layout of a dockview that is gone.
  useEffect(() => {
    if (!dock) {
      return;
    }

    const instance = createLayoutSaver(
      () => dock.toJSON(),
      (layout) => {
        writeLayout(user, tenant, layout);
      },
    );
    saver.current = instance;
    // The first save also replaces a saved layout that did not open with the default one.
    instance.schedule();
    const layoutSub = dock.onDidLayoutChange(() => {
      instance.schedule();
    });
    const failSub = dock.onDidOpenPopoutWindowFail((failure) => {
      log.warn("The popout window did not open.", { reason: failure.reason });
      setNotice("The browser did not open the popout window. Allow popups for this site.");
    });
    // A closing page would lose the last change, so the saver also writes at pagehide.
    const onPageHide = (): void => {
      instance.flush();
      closePanelWindows();
    };
    addEventListener("pagehide", onPageHide);

    return () => {
      removeEventListener("pagehide", onPageHide);
      layoutSub.dispose();
      failSub.dispose();
      instance.dispose();
      saver.current = null;
    };
  }, [dock, user, tenant]);

  const onReady = useCallback(
    (event: DockviewReadyEvent): void => {
      const instance = event.api;
      restoreLayout(
        instance,
        readLayout(user, tenant),
        () => {
          addDefaultPanels(instance);
        },
        (reason) => {
          log.warn("The saved layout did not open. The default layout opens instead.", {
            reason,
          });
        },
      );
      setDock(instance);
    },
    [user, tenant],
  );

  const resetLayout = (): void => {
    if (!dock) {
      return;
    }

    dock.clear();
    addDefaultPanels(dock);
    saver.current?.flush();
  };

  // A leave starts a logout, a tenant switch or a shared-device logout. The layout is saved
  // first, because the next step can remove the user from the page. The windows of single panels
  // have a session of their own, and they close with this one.
  const leaving = (action: () => void): void => {
    saver.current?.flush();
    closePanelWindows();
    action();
  };

  return (
    <WorkspaceContext.Provider value={context}>
      <header className="bar">
        <h1>FX workspace</h1>
        <div className="bar-tools">
          <MenuButton label={<>Add panel {"▾"}</>} action="add-panel" menuLabel="Add panel">
            {(close) =>
              PANELS.map((panel) => (
                <button
                  key={panel.id}
                  type="button"
                  role="menuitem"
                  data-observability-action="add-panel-item"
                  onClick={() => {
                    close();
                    if (dock) {
                      openPanel(dock, panel.id);
                    }
                  }}
                >
                  {panel.title}
                  <span className="muted"> {panel.description}</span>
                </button>
              ))
            }
          </MenuButton>
          <button type="button" data-observability-action="reset-layout" onClick={resetLayout}>
            Reset layout
          </button>
          <label className="inline">
            Theme
            <select
              value={theme}
              onChange={(event) => {
                setTheme(event.target.value === "light" ? "light" : "dark");
              }}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <UserMenu
            user={user}
            tenant={tenant}
            tenants={tenants}
            busy={busy}
            onSwitchTenant={(next) => {
              leaving(() => {
                onSwitchTenant(next);
              });
            }}
            onPrivacy={() => {
              setPrivacyOpen(true);
            }}
            onRefreshToken={() => {
              refreshSession(api).catch((error: unknown) => {
                log.error("token refresh failed", error);
              });
            }}
            onLogout={() => {
              leaving(onLogout);
            }}
            onLogoutShared={() => {
              leaving(onLogoutShared);
            }}
          />
        </div>
      </header>
      <p role="status" className="warn notice">
        {notice}
      </p>
      <div className="dockview-host">
        <DockviewReact
          components={PANEL_COMPONENTS}
          theme={THEMES[theme]}
          popoutUrl="/popout.html"
          watermarkComponent={Watermark}
          rightHeaderActionsComponent={HeaderActions}
          getTabContextMenuItems={({ panel }) =>
            // "popout" moves a panel into a popout window, which a frame panel can't do.
            TAB_CONTEXT_MENU.filter((item) => item !== "popout" || !isFramePanel(panel.id))
          }
          onWillDrop={blockFrameDrop}
          onReady={onReady}
        />
      </div>
      <PrivacyDialog
        open={privacyOpen}
        onClose={() => {
          setPrivacyOpen(false);
        }}
      />
    </WorkspaceContext.Provider>
  );
}
