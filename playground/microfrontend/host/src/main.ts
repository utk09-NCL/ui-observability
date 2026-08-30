import { configure, getLogger, startJourney } from "@utk09/ui-observability";

// The shell owns configuration. One document holds one runtime, so this call
// configures both remotes as well as the shell.
configure({
  endpoint: "http://localhost:8787/v1/logs",
  serviceName: "example-shell",
  serviceVersion: "0.0.0",
  environment: "local",
  minLevel: "TRACE",
  console: { enabled: true },
  sampling: {
    defaultRate: 1,
    // Rates are per namespace, which is how one chatty remote turns down
    // without touching the others. POSITIONS_LOAD still arrives every time:
    // alwaysSampleTypes keeps every action, so this rate reaches only the
    // blotter's own log records.
    rates: { "blotter.grid": 0.05 },
  },
  capture: { errors: true, rejections: true, fetch: true, interactions: true, navigation: true },
});

const log = getLogger("shell");

// The journey opens before the first record. Logging first gives that one
// record whichever journey the tab was already carrying, so the shell's own
// boot line arrives under a different journey.id than everything after it.
startJourney("order-lifecycle");
log.info("shell booted");

/**
 * Hands one panel to the remote that fills it. A remote that fails to load
 * leaves its own panel empty and reports. Awaiting both in one `Promise.all`
 * instead means a broken ticket also blanks a healthy blotter.
 * @param selector Panel element selector.
 * @param load Dynamic import of the remote's mount module.
 */
async function mountInto(
  selector: string,
  load: () => Promise<{ mount: (el: HTMLElement) => void }>,
): Promise<void> {
  const el = document.querySelector<HTMLElement>(selector);

  if (!el) {
    throw new Error(`index.html is missing ${selector}`);
  }

  try {
    const { mount } = await load();
    mount(el);
  } catch (error) {
    log.error(`the remote for ${selector} did not load`, error);
  }
}

await Promise.all([
  mountInto("#blotter", () => import("blotter/mount")),
  mountInto("#ticket", () => import("ticket/mount")),
]);
