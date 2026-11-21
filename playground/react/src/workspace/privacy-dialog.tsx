// src/workspace/privacy-dialog.tsx
//
// "Privacy choices". It follows the "Consent withdrawal" recipe. A withdrawal stops the library,
// drops what it did not send and leaves it with no endpoint. The choice stays in localStorage,
// so the next page load starts paused. The replay switch starts and stops the recorder. The
// config has replay.requireConsent, so nothing records before the user agrees here.

import { type ReactElement, useEffect, useRef, useState } from "react";
import { getLogger } from "@utk09/ui-observability";
import { loadConsent, type Consent } from "../observability/consent";
import { setReplayConsent, setTelemetryConsent } from "../observability/user-context";
import { runExclusive, useBusy } from "../observability-settings/operation-queue";
import { getSettingsState } from "../observability-settings/settings-store";

const log = getLogger("workspace.privacy");

/**
 * Renders a modal dialog that opens when `open` turns true.
 * @param props `open` shows the dialog. `onClose` runs when it closes.
 * @returns The dialog.
 */
export function PrivacyDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [consent, setConsent] = useState<Consent>(loadConsent);
  const [status, setStatus] = useState("");
  const busy = useBusy();

  // Shows and hides the native dialog to match the prop. The browser traps the focus in it.
  useEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }

    if (open && !element.open) {
      setConsent(loadConsent());
      setStatus("");
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  const changeTelemetry = (allowed: boolean): void => {
    setConsent((previous) => ({ ...previous, telemetry: allowed }));
    setStatus(allowed ? "Resuming telemetry." : "Stopping telemetry.");
    // In the queue, so a withdrawal never meets a login or a restart.
    runExclusive(() => setTelemetryConsent(allowed, getSettingsState().applied))
      .then(() => {
        setStatus(allowed ? "Telemetry is on." : "Telemetry is off. Nothing leaves this page.");
      })
      .catch((error: unknown) => {
        log.error("The consent change failed.", error);
        setStatus("The change failed. Reload the page.");
      });
  };

  const changeReplay = (allowed: boolean): void => {
    setConsent((previous) => ({ ...previous, replay: allowed }));
    // In the queue, like the telemetry choice, so it can't meet a rotation or a restart.
    runExclusive(() => {
      setReplayConsent(allowed);

      return Promise.resolve();
    })
      .then(() => {
        setStatus(allowed ? "The replay records." : "The replay is off.");
      })
      .catch((error: unknown) => {
        log.error("The replay change failed.", error);
        setStatus("The change failed. Reload the page.");
      });
  };

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="privacy-heading" onClose={onClose}>
      <h2 id="privacy-heading">Privacy choices</h2>
      <label className="inline">
        <input
          type="checkbox"
          checked={consent.telemetry}
          disabled={busy}
          onChange={(event) => {
            changeTelemetry(event.target.checked);
          }}
        />
        Send telemetry about this session
      </label>
      <p className="muted">
        When you clear it, the library stops, drops the records that it did not send and has no
        endpoint. Your choice stays on this device.
      </p>
      <label className="inline">
        <input
          type="checkbox"
          checked={consent.replay}
          disabled={busy || !consent.telemetry}
          onChange={(event) => {
            changeReplay(event.target.checked);
          }}
        />
        Record this session for support
      </label>
      <p className="muted">
        When you agree, the library records the page and keeps the last minute in memory. After an
        error, it sends that minute to the support service. The recorder masks the text and the
        input values. It needs the telemetry switch above.
      </p>
      <p role="status" className="muted">
        {status}
      </p>
      <div className="controls">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
