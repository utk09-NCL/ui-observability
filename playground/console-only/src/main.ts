// playground/console-only/src/main.ts
//
// A console-only consumer with no optional peer installed.
// The key list must stay empty.

import { getLogger } from "./logger";

/** Prefix of every storage key the library can write. */
const KEY_PREFIX = "ui-observability.";

/** Module-scope logger, so getLogger runs at module load. */
const log = getLogger("board.hop");

/**
 * Finds an element by selector.
 * @param selector CSS selector.
 * @returns The element.
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
 * @returns One line per matching key.
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

/** Shows the library's localStorage and sessionStorage keys on the page. */
const renderKeys = (): void => {
  const lines = [
    ...listKeys(localStorage, "localStorage"),
    ...listKeys(sessionStorage, "sessionStorage"),
  ];

  el("#keys").textContent = lines.length > 0 ? lines.join("\n") : "(none)";
};

/**
 * Adds a click listener to a button and refreshes the key list after the callback runs.
 * @param id Element id, without the "#".
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
