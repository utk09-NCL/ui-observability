import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { getLogger } from "ui-observability";

// The same library, the same runtime, a different framework. Nothing on the
// records says which remote produced them except app.namespace.
const log = getLogger("ticket.form");

/**
 * The ticket's one control.
 * @returns Submit button.
 */
function Ticket(): ReactElement {
  return (
    <button
      onClick={() => {
        log.logAction("ORDER_SUBMIT", { orderId: "ORD-3003" });
      }}
    >
      submit from the React remote
    </button>
  );
}

/**
 * Renders the ticket panel.
 * @param el Panel element the host owns.
 */
export function mount(el: HTMLElement): void {
  createRoot(el).render(<Ticket />);
  log.info("ticket remote mounted");
}
