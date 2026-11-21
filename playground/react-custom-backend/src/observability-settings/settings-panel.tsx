// src/observability-settings/settings-panel.tsx
//
// The settings table. Each setting has a row with its current value, the faster value, what it
// costs, how sure the claim is, and whether the change applies now or needs a restart. A second
// row under it gives the reason at the full width of the table, so the table has four columns
// and fits in the right-hand column without a horizontal scroll.

import { type ChangeEvent, Fragment, type ReactElement, useState } from "react";
import { formatValue, type Group, type Hint, HINTS } from "./hints";
import { useBusy } from "./operation-queue";
import type { Settings } from "./settings";
import {
  applyFasterValues,
  applyStaged,
  changeSetting,
  resetSettings,
  stagedKeys,
  useSettingsState,
} from "./settings-store";

const GROUPS: Group[] = ["Logging", "Capture", "Delivery", "Privacy and metadata"];

interface RowProps {
  hint: Hint;
  value: boolean | number | string;
  staged: boolean;
  disabled: boolean;
}

function SettingRow({ hint, value, staged, disabled }: RowProps): ReactElement {
  const id = `setting-${hint.key}`;
  const isFaster = hint.faster !== null && hint.faster === value;
  let applies = hint.applies === "runtime" ? "Applies now" : "Needs restart";
  if (staged) {
    applies = "Staged. Needs restart";
  }

  const onChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const option = hint.options.find((candidate) => String(candidate) === event.target.value);
    if (option !== undefined) {
      void changeSetting(hint.key, option);
    }
  };

  return (
    <Fragment>
      <tr role="row" className={staged ? "staged" : undefined}>
        <td role="cell">
          <label htmlFor={id}>{hint.label}</label>
          <div>
            <code>{hint.path}</code>
          </div>
        </td>
        <td role="cell">
          <select id={id} value={String(value)} disabled={disabled} onChange={onChange}>
            {hint.options.map((option) => (
              <option key={String(option)} value={String(option)}>
                {formatValue(option, hint.unit)}
              </option>
            ))}
          </select>
        </td>
        <td role="cell">
          <strong>
            {hint.faster === null ? "none known" : formatValue(hint.faster, hint.unit)}
          </strong>
          {isFaster && <span className="muted"> (in use)</span>}
          <div>{hint.cost}</div>
        </td>
        <td role="cell">
          <div className="badges">
            <span className={`badge badge-${hint.evidence.replace(" ", "-")}`}>
              {hint.evidence}
            </span>
            <span className={staged ? "badge badge-staged" : "badge"}>{applies}</span>
          </div>
        </td>
      </tr>
      <tr role="row" className={staged ? "why staged" : "why"}>
        <td role="cell" colSpan={4} className="muted">
          {hint.why}
        </td>
      </tr>
    </Fragment>
  );
}

/**
 * The settings table with its three buttons.
 * @param props `onRestart` stops the library and starts it again with the given settings.
 * @returns The panel.
 */
export function SettingsPanel({
  onRestart,
}: {
  onRestart: (settings: Settings) => Promise<void>;
}): ReactElement {
  const state = useSettingsState();
  // True while a login, a logout, a restart or a change of setting runs.
  const busy = useBusy();
  const [status, setStatus] = useState("");
  const staged = stagedKeys(state);

  const restart = async (): Promise<void> => {
    setStatus("Restarting the library.");
    await applyStaged(onRestart);
    setStatus("Restarted. The new settings are in force.");
  };

  return (
    <section aria-labelledby="settings-heading">
      <h3 id="settings-heading">Settings</h3>
      <div className="controls">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void applyFasterValues();
          }}
        >
          Use all faster values
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void resetSettings();
          }}
        >
          Reset to defaults
        </button>
        <button
          type="button"
          disabled={busy || staged.length === 0}
          onClick={() => {
            void restart();
          }}
        >
          Apply and restart ({staged.length} staged)
        </button>
        <span role="status" className="muted">
          {status}
        </span>
      </div>
      <div className="table-scroll">
        <table role="table" className="settings">
          <colgroup>
            <col className="col-setting" />
            <col className="col-value" />
            <col className="col-faster" />
            <col className="col-status" />
          </colgroup>
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">
                Setting
              </th>
              <th role="columnheader" scope="col">
                Value
              </th>
              <th role="columnheader" scope="col">
                Faster value, and what it costs
              </th>
              <th role="columnheader" scope="col">
                Evidence and change
              </th>
            </tr>
          </thead>
          {GROUPS.map((group) => (
            <tbody key={group} role="rowgroup">
              <tr role="row">
                <th role="rowheader" colSpan={4} scope="rowgroup" className="group">
                  {group}
                </th>
              </tr>
              {HINTS.filter((hint) => hint.group === group).map((hint) => (
                <SettingRow
                  key={hint.key}
                  hint={hint}
                  value={state.draft[hint.key]}
                  staged={staged.includes(hint.key)}
                  disabled={busy}
                />
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}
