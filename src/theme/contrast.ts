/** WCAG 2.x contrast, as rlx's TUI measures its themes (tests/test_ui_rlx_theme.py in rlx). */

/** Minimum contrast for text (WCAG 1.4.3) and for UI parts such as borders and focus rings (1.4.11). */
export const TEXT_CONTRAST = 4.5;
export const UI_CONTRAST = 3;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#RRGGBB` colour. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const [r, g, b] = match.slice(1).map((part) => channel(parseInt(part, 16))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two `#RRGGBB` colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
