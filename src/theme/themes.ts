/**
 * Colour themes as design tokens. Each token becomes a CSS variable, `--rlx-<token>`,
 * declared in ./tokens.css. A test checks that the two files agree, so widgets
 * (including agent-made ones) can style themselves with `var(--rlx-…)`.
 */
import { TEXT_CONTRAST, UI_CONTRAST } from "./contrast.ts";

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

export type TokenName = keyof ThemeTokens;

export interface Theme {
  name: string;
  dark: boolean;
  tokens: ThemeTokens;
}

/**
 * rlx's own theme, equal to RLX_THEME in rlx's TUI (src/aisquare/cli/ui/theme.py).
 * Labels on the blue use the ground (4.63:1), not white (4.31:1).
 */
export const RLX_THEME: Theme = {
  name: "rlx",
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
};

/** Every theme the app ships; the contrast test runs over all of them. */
export const THEMES: readonly Theme[] = [RLX_THEME];

export const DEFAULT_THEME = RLX_THEME.name;

export interface ContrastPair {
  fg: TokenName;
  bg: TokenName;
  min: number;
  /** Where the pair is drawn, so a failure says what breaks. */
  use: string;
}

/**
 * The colour pairs the UI draws. These follow the contrast table in rlx's TUI theme tests,
 * restricted to the tokens defined here. Extend the list when a new pairing is used.
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
  { fg: "success", bg: "background", min: TEXT_CONTRAST, use: "success text" },
  { fg: "success", bg: "surface", min: TEXT_CONTRAST, use: "success text in a dialog" },
  { fg: "warning", bg: "background", min: TEXT_CONTRAST, use: "warning text" },
  { fg: "warning", bg: "surface", min: TEXT_CONTRAST, use: "warning text in a dialog" },
  { fg: "error", bg: "background", min: TEXT_CONTRAST, use: "error text" },
  { fg: "error", bg: "surface", min: TEXT_CONTRAST, use: "error text in a dialog" },
  { fg: "primary", bg: "background", min: UI_CONTRAST, use: "borders and focus rings" },
  { fg: "primary", bg: "surface", min: UI_CONTRAST, use: "a dialog's border" },
  { fg: "primary", bg: "panel", min: UI_CONTRAST, use: "a card's border" },
  { fg: "accent", bg: "surface", min: UI_CONTRAST, use: "a dialog's accent border" },
  { fg: "secondary", bg: "background", min: UI_CONTRAST, use: "a highlighted feed border" },
];
