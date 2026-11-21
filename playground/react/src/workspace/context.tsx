// src/workspace/context.tsx
//
// What each panel needs from the page: the API client and the session. A panel is rendered
// through a portal of dockview, and a React context passes through a portal, so a panel reads
// this context also when it sits in a floating group or a popout window.

import { createContext, useContext } from "react";
import type { Api } from "../api/client";
import type { Session } from "../session/session";

export interface WorkspaceContextValue {
  api: Api;
  session: Session;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Reads the API client and the session of the workspace.
 * @returns The context value.
 */
export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("A panel must render inside the workspace.");
  }

  return value;
}
