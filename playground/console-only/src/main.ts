// playground/console-only/src/main.ts
//
// Console-only consumer with no optional peer installed.
// The key list must stay empty.

import { getLogger } from "./logger";

/** Prefix of each storage key the library can write. */
const KEY_PREFIX = "ui-observability.";

/** Module-scope logger. This line calls getLogger at module load. */
const log = getLogger("board.hop");

/**
 * Queries a DOM element by selector.
 * @param selector CSS selector string.
 * @returns Matched DOM element.
 */
const el = (selector: string): Element => {
  const found = document.querySelector(selector);

  if (!found) {
    throw new Error(`console-only: no element matches ${selector}`);
  }

  return found;
};

/**
 * Lists the keys in a storage area that start with the library prefix.
 * @param area Storage area to read.
 * @param label Name shown in front of each key.
 * @returns One line for each matched key.
 */
const listKeys = (area: Storage, label: string): string[] => {
  const lines: string[] = [];

  for (let i = 0; i < area.length; i++) {
    const key = area.key(i);

    if (key?.startsWith(KEY_PREFIX)) {
      lines.push(`${label}  ${key}`);
    }
  }

  return lines;
};

/** Writes the library keys of localStorage and sessionStorage into the page. */
const renderKeys = (): void => {
  const lines = [
    ...listKeys(localStorage, "localStorage"),
    ...listKeys(sessionStorage, "sessionStorage"),
  ];

  el("#keys").textContent = lines.length > 0 ? lines.join("\n") : "(none)";
};

/**
 * Binds a click listener to a button. The listener refreshes the key list after the callback.
 * @param id Element ID without prefix.
 * @param fn Click callback.
 */
const on = (id: string, fn: () => void): void => {
  el(`#${id}`).addEventListener("click", () => {
    fn();
    renderKeys();
  });
};

on("debug", () => {
  log.debug("debug from console-only", { button: "debug" });
});

on("info", () => {
  log.info("info from console-only", { button: "info" });
});

on("warn", () => {
  log.warn("warn from console-only", { button: "warn" });
});

on("error", () => {
  log.error("error from console-only", new Error("boom"), { button: "error", orderId: "ORD-1" });
});

on("nested", () => {
  log.child("panel").info("info from a nested namespace", { button: "nested" });
});

renderKeys();
