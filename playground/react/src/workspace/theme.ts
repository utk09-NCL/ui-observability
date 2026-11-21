// src/workspace/theme.ts
//
// The two dockview themes of the workspace, and the stored choice. Dark is the default.

import { type DockviewTheme, themeDark, themeLight } from "dockview-react";

export type ThemeName = "dark" | "light";

const STORAGE_KEY = "react-workspace.theme";

export const THEMES: Record<ThemeName, DockviewTheme> = {
  dark: themeDark,
  light: themeLight,
};

/**
 * Reads the stored theme. A blocked store or an unknown value gives the dark theme.
 * @returns The theme name.
 */
export function loadTheme(): ThemeName {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    // A private window or blocked site data. The default theme is the fallback.
    return "dark";
  }
}

/**
 * Stores the theme and marks the page, so the CSS outside dockview follows it.
 * @param name The theme to keep.
 */
export function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // The choice then lasts until the page closes.
  }
}
