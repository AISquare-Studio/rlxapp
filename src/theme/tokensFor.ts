import type { Settings } from "../state/model.ts";
import { effectiveAccent, resolveTheme } from "./themes.ts";

/** The live theme's tokens for the given settings, as a widget receives them in `init`. */
export function tokensFor(settings: Pick<Settings, "family" | "mode" | "accent">, osDark: boolean): Record<string, string> {
  const theme = resolveTheme(settings.family, settings.mode, osDark);
  return { ...theme.tokens, ...theme.ui, accent: effectiveAccent(theme, settings.accent) };
}
