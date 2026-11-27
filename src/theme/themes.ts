/**
 * Colour themes as design tokens. Each token becomes a CSS variable, `--rlx-<token>`,
 * declared in ./tokens.css. A test checks that the two files agree, so widgets
 * (including agent-made ones) can style themselves with `var(--rlx-…)`.
 */
import { TEXT_CONTRAST, UI_CONTRAST, contrast } from "./contrast.ts";

/** The tokens rlx's TUI theme defines. The "rlx" theme's values equal RLX_THEME in rlx. */
export interface ThemeTokens {
  /** The brand blue: borders, focus, primary buttons. */
  primary: string;
  secondary: string;
  accent: string;
  warning: string;
  error: string;
  success: string;
  /** Body text. */
  foreground: string;
  /** The window's ground. */
  background: string;
  /** Raised areas such as dialogs. */
  surface: string;
  /** Cards, footer. */
  panel: string;
  /** Labels drawn on primary/success/warning/error fills. */
  "on-primary": string;
  /** The r\x mark and the product name. */
  mark: string;
}

/** App-only tokens the TUI has no equivalent for. */
export interface UiTokens {
  /** Secondary text: timestamps, captions. */
  muted: string;
  /** Hairlines between panels (decorative; focus and controls use `primary`). */
  border: string;
}

export type TokenName = keyof ThemeTokens;
export type UiTokenName = keyof UiTokens;
export type AnyTokenName = TokenName | UiTokenName;

export type ThemeFamily = "rlx" | "catppuccin" | "solarized";

export interface Theme {
  name: string;
  label: string;
  family: ThemeFamily;
  dark: boolean;
  tokens: ThemeTokens;
  ui: UiTokens;
}

/**
 * rlx's own theme, equal to RLX_THEME in rlx's TUI (src/aisquare/cli/ui/theme.py).
 * Labels on the blue use the ground (4.63:1), not white (4.31:1).
 */
export const RLX_THEME: Theme = {
  name: "rlx",
  label: "rlx",
  family: "rlx",
  dark: true,
  tokens: {
    primary: "#2F74F0",
    secondary: "#E8FF3A",
    accent: "#14B8A6",
    warning: "#FF9F1C",
    error: "#FF5A5F",
    success: "#2BF07A",
    foreground: "#F1F2F4",
    background: "#08090B",
    surface: "#121317",
    panel: "#1A1B20",
    "on-primary": "#08090B",
    mark: "#2F74F0",
  },
  ui: { muted: "#A3A8B3", border: "#2A2C33" },
};

/** rlx's refined light variant: the same brand, darkened where a light ground needs it. */
export const RLX_LIGHT_THEME: Theme = {
  name: "rlx-light",
  label: "rlx light",
  family: "rlx",
  dark: false,
  tokens: {
    primary: "#1E5FD6",
    secondary: "#6A7A00",
    accent: "#0F766E",
    warning: "#A85400",
    error: "#C42B2F",
    success: "#15803D",
    foreground: "#121317",
    background: "#F6F7F9",
    surface: "#FFFFFF",
    panel: "#ECEEF2",
    "on-primary": "#FFFFFF",
    mark: "#1E5FD6",
  },
  ui: { muted: "#505662", border: "#D5D9E0" },
};

/** Ports of themes the TUI offers, tuned where the originals miss WCAG. */
export const CATPPUCCIN_MOCHA: Theme = {
  name: "catppuccin-mocha",
  label: "Catppuccin Mocha",
  family: "catppuccin",
  dark: true,
  tokens: {
    primary: "#89B4FA",
    secondary: "#F9E2AF",
    accent: "#94E2D5",
    warning: "#FAB387",
    error: "#F38BA8",
    success: "#A6E3A1",
    foreground: "#CDD6F4",
    background: "#1E1E2E",
    surface: "#181825",
    panel: "#313244",
    "on-primary": "#11111B",
    mark: "#89B4FA",
  },
  ui: { muted: "#A6ADC8", border: "#45475A" },
};

export const CATPPUCCIN_LATTE: Theme = {
  name: "catppuccin-latte",
  label: "Catppuccin Latte",
  family: "catppuccin",
  dark: false,
  tokens: {
    primary: "#1E66F5",
    secondary: "#8C6A00",
    accent: "#0E6B6D",
    warning: "#B04A00",
    error: "#C9184A",
    success: "#2B7A12",
    foreground: "#4C4F69",
    background: "#EFF1F5",
    surface: "#FFFFFF",
    panel: "#E6E9EF",
    "on-primary": "#FFFFFF",
    mark: "#1A5BDB",
  },
  ui: { muted: "#5C5F77", border: "#CCD0DA" },
};

export const SOLARIZED_DARK: Theme = {
  name: "solarized-dark",
  label: "Solarized Dark",
  family: "solarized",
  dark: true,
  tokens: {
    primary: "#4BA3E8",
    secondary: "#B58900",
    accent: "#3CBDB3",
    warning: "#D9822B",
    error: "#F2615E",
    success: "#99B300",
    foreground: "#E3E3DA",
    background: "#002B36",
    surface: "#00212B",
    panel: "#073642",
    "on-primary": "#00212B",
    mark: "#4BA3E8",
  },
  ui: { muted: "#A3B1B3", border: "#1C4A55" },
};

export const SOLARIZED_LIGHT: Theme = {
  name: "solarized-light",
  label: "Solarized Light",
  family: "solarized",
  dark: false,
  tokens: {
    primary: "#1F6FB0",
    secondary: "#8A6800",
    accent: "#116D67",
    warning: "#A84E00",
    error: "#C2272D",
    success: "#5A6B00",
    foreground: "#2F3E44",
    background: "#FDF6E3",
    surface: "#FFFFFF",
    panel: "#EEE8D5",
    "on-primary": "#FFFFFF",
    mark: "#1F6FB0",
  },
  ui: { muted: "#4E5E64", border: "#D9D2BD" },
};

/** Every theme the app ships; the contrast test runs over all of them. */
export const THEMES: readonly Theme[] = [
  RLX_THEME,
  RLX_LIGHT_THEME,
  CATPPUCCIN_MOCHA,
  CATPPUCCIN_LATTE,
  SOLARIZED_DARK,
  SOLARIZED_LIGHT,
];

export const DEFAULT_THEME = RLX_THEME.name;

export const FAMILIES: readonly { family: ThemeFamily; label: string; dark: string; light: string }[] = [
  { family: "rlx", label: "rlx", dark: "rlx", light: "rlx-light" },
  { family: "catppuccin", label: "Catppuccin", dark: "catppuccin-mocha", light: "catppuccin-latte" },
  { family: "solarized", label: "Solarized", dark: "solarized-dark", light: "solarized-light" },
];

export function themeByName(name: string): Theme {
  return THEMES.find((theme) => theme.name === name) ?? RLX_THEME;
}

/** Which theme a family shows in a mode; "system" follows the OS. */
export function resolveTheme(family: ThemeFamily, mode: "dark" | "light" | "system", osDark: boolean): Theme {
  const entry = FAMILIES.find((f) => f.family === family) ?? FAMILIES[0];
  const dark = mode === "system" ? osDark : mode === "dark";
  return themeByName(dark ? (entry?.dark ?? "rlx") : (entry?.light ?? "rlx-light"));
}

export interface AccentPreset {
  id: string;
  label: string;
  /** The value on dark themes and on light themes. */
  dark: string;
  light: string;
}

/** Accent colours the user can pick; each passes the accent pairs on every shipped theme. */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "teal", label: "Teal", dark: "#2DD4BF", light: "#0E6B6D" },
  { id: "violet", label: "Violet", dark: "#B9A6FF", light: "#6A3FC8" },
  { id: "pink", label: "Pink", dark: "#FF85BE", light: "#B01F66" },
  { id: "amber", label: "Amber", dark: "#FFB547", light: "#875800" },
  { id: "sky", label: "Sky", dark: "#5CC8FF", light: "#0A6699" },
];

export interface ContrastPair {
  fg: AnyTokenName;
  bg: AnyTokenName;
  min: number;
  /** Where the pair is drawn, so a failure says what breaks. */
  use: string;
}

/**
 * The colour pairs the UI draws. These follow the contrast table in rlx's TUI theme tests,
 * plus the app's own pairs. Extend the list when a new pairing is used.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: "foreground", bg: "background", min: TEXT_CONTRAST, use: "page text" },
  { fg: "foreground", bg: "surface", min: TEXT_CONTRAST, use: "dialog text" },
  { fg: "foreground", bg: "panel", min: TEXT_CONTRAST, use: "card and footer text" },
  { fg: "mark", bg: "background", min: TEXT_CONTRAST, use: "the r\\x mark and product name" },
  { fg: "on-primary", bg: "primary", min: TEXT_CONTRAST, use: "a primary button's label" },
  { fg: "on-primary", bg: "success", min: TEXT_CONTRAST, use: "a success button's label" },
  { fg: "on-primary", bg: "warning", min: TEXT_CONTRAST, use: "a warning button's label" },
  { fg: "on-primary", bg: "error", min: TEXT_CONTRAST, use: "an error button's label" },
  { fg: "accent", bg: "background", min: TEXT_CONTRAST, use: "accent text and chips" },
  { fg: "accent", bg: "panel", min: TEXT_CONTRAST, use: "accent text on a card" },
  { fg: "success", bg: "background", min: TEXT_CONTRAST, use: "success text" },
  { fg: "success", bg: "surface", min: TEXT_CONTRAST, use: "success text in a dialog" },
  { fg: "warning", bg: "background", min: TEXT_CONTRAST, use: "warning text" },
  { fg: "warning", bg: "surface", min: TEXT_CONTRAST, use: "warning text in a dialog" },
  { fg: "error", bg: "background", min: TEXT_CONTRAST, use: "error text" },
  { fg: "error", bg: "surface", min: TEXT_CONTRAST, use: "error text in a dialog" },
  { fg: "muted", bg: "background", min: TEXT_CONTRAST, use: "secondary text" },
  { fg: "muted", bg: "surface", min: TEXT_CONTRAST, use: "secondary text in a dialog" },
  { fg: "muted", bg: "panel", min: TEXT_CONTRAST, use: "secondary text on a card" },
  { fg: "primary", bg: "background", min: UI_CONTRAST, use: "borders and focus rings" },
  { fg: "primary", bg: "surface", min: UI_CONTRAST, use: "a dialog's border" },
  { fg: "primary", bg: "panel", min: UI_CONTRAST, use: "a card's border and focus ring" },
  { fg: "accent", bg: "surface", min: UI_CONTRAST, use: "a dialog's accent border" },
  { fg: "secondary", bg: "background", min: UI_CONTRAST, use: "a highlighted feed border" },
];

/** The accent pairs, which a picked accent must also meet. */
export const ACCENT_PAIRS: readonly ContrastPair[] = CONTRAST_PAIRS.filter((pair) => pair.fg === "accent");

/** A theme's colour for any token name. */
export function tokenValue(theme: Theme, name: AnyTokenName): string {
  return name in theme.tokens ? theme.tokens[name as TokenName] : theme.ui[name as UiTokenName];
}

/** Whether `accent` meets every accent pair on `theme`. */
export function accentPasses(theme: Theme, accent: string): boolean {
  return ACCENT_PAIRS.every((pair) => contrast(accent, tokenValue(theme, pair.bg)) >= pair.min);
}

function toRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  return [parseInt(m[1] ?? "0", 16), parseInt(m[2] ?? "0", 16), parseInt(m[3] ?? "0", 16)];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * A custom accent adjusted to pass on `theme`: mixed toward white on dark themes and toward
 * black on light ones, in small steps, until every accent pair passes. Keeps the hue.
 */
export function fitAccent(theme: Theme, wanted: string): string {
  const base = toRgb(wanted);
  const target: [number, number, number] = theme.dark ? [255, 255, 255] : [0, 0, 0];
  for (let step = 0; step <= 100; step += 2) {
    const t = step / 100;
    const candidate = toHex([0, 1, 2].map((i) => (base[i] ?? 0) * (1 - t) + (target[i] ?? 0) * t) as [number, number, number]);
    if (accentPasses(theme, candidate)) return candidate;
  }
  return theme.tokens.accent;
}

/** The accent to draw: a preset's value for the theme's mode, a fitted custom colour, or the theme's own. */
export function effectiveAccent(theme: Theme, accent: { kind: "theme" } | { kind: "preset"; id: string } | { kind: "custom"; hex: string }): string {
  if (accent.kind === "preset") {
    const preset = ACCENT_PRESETS.find((p) => p.id === accent.id);
    if (preset) return theme.dark ? preset.dark : preset.light;
  }
  if (accent.kind === "custom") return fitAccent(theme, accent.hex);
  return theme.tokens.accent;
}
