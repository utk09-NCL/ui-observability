import { getLogger } from "@utk09/ui-observability";

// A namespace, never a second configure(). A remote that calls configure()
// reconfigures the one runtime in the document, which renames service.name on
// every record the shell and the other remote emit from then on.
const log = getLogger("blotter.grid");

/**
 * Renders the blotter panel.
 * @param el Panel element the host owns.
 */
export function mount(el: HTMLElement): void {
  const button = document.createElement("button");
  button.textContent = "load positions";
  button.addEventListener("click", () => {
    log.logAction("POSITIONS_LOAD", { rows: 512 });
  });

  el.append(button);
  log.info("blotter remote mounted");
}
