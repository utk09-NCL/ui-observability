// src/frames/frame-page.ts
//
// What the frame pages of this app have in common: an element lookup that fails loudly, and a
// diagnostic handler that shows the bus role and the last diagnostic in the page. The role tells
// a reader whether the frame forwards to its parent or sends for itself.

import type { DiagnosticEvent } from "@utk09/ui-observability";

/**
 * Finds an element by selector and throws if it is missing.
 * @param selector CSS selector.
 * @returns The element.
 */
export function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`frame page: no element matches ${selector}`);
  }

  return found;
}

/**
 * Builds an onDiagnostic handler that writes the bus role and the last bus diagnostic.
 * @param role The element for the role.
 * @param note The element for the last diagnostic.
 * @returns The handler.
 */
export function showBusRole(
  role: HTMLElement,
  note: HTMLElement,
): (event: DiagnosticEvent) => void {
  return (event) => {
    // bus.role_resolved carries the resolved role, which is the readout of the frame.
    if (event.code === "bus.role_resolved" && typeof event.detail?.role === "string") {
      role.textContent = event.detail.role;
    }
    if (event.code.startsWith("bus.")) {
      note.textContent = `${event.code}: ${event.message}`;
    }
  };
}
