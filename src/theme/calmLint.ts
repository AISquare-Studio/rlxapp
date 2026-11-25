/**
 * The calm-design lint (rule-calm-design.md): component CSS may use design tokens only.
 * `npm run lint` runs it on every stylesheet (scripts/lint-calm.mjs), and so does CI.
 *
 * It fails on:
 *   - a border width other than the token (`var(--rlx-border-width)`), including 2 px and
 *     thin/medium/thick, and outlines other than the focus ring's tokens;
 *   - one-side accent bars: any visible border-left / border-right (or inline-start/end),
 *     and inset box-shadow bars or rings;
 *   - raw colours (hex, rgb(), hsl(), oklch(), named colours) outside the token files;
 *   - font sizes, radii and spacing (padding, margin, gap) that aren't tokens.
 */

export interface CalmViolation {
  line: number;
  rule: "border-width" | "side-accent" | "inset-bar" | "raw-color" | "font-size" | "radius" | "spacing" | "outline";
  text: string;
}

/** Files that define the tokens, where raw values belong. */
export const TOKEN_FILES = ["src/theme/tokens.css"];

const NAMED_COLORS = [
  "black", "white", "red", "green", "blue", "yellow", "orange", "purple", "pink", "gray", "grey",
  "silver", "maroon", "navy", "teal", "olive", "lime", "aqua", "fuchsia", "cyan", "magenta",
  "brown", "gold", "indigo", "violet", "crimson", "coral", "salmon", "tomato", "khaki", "beige",
];
const RAW_COLOR = new RegExp(
  `#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(|\\b(?:${NAMED_COLORS.join("|")})\\b`,
  "i",
);
/** A length with a unit; unitless numbers (calc() multipliers) aren't lengths. */
const LENGTH = /(?<![\w-])-?\d*\.?\d+(?:px|em|rem|%|vh|vw|pt)(?![\w-])/g;
const SIDE = /^border-(?:left|right|inline-start|inline-end|inline)(?:-width|-style|-color)?$/;
const BORDER = /^border(?:-(?:top|bottom|block|block-start|block-end))?(?:-width)?$/;

/** A length is allowed in spacing if it's zero; everything else must come from a token. */
function nonZeroLengths(value: string): string[] {
  const stripped = value.replace(/var\([^()]*\)/g, " ").replace(/calc\(/g, " (");
  return [...stripped.matchAll(LENGTH)].map((m) => m[0]).filter((n) => Number.parseFloat(n) !== 0);
}

/** Lints one stylesheet. `path` decides whether raw colours are allowed (token files). */
export function lintCalm(css: string, path: string): CalmViolation[] {
  const tokenFile = TOKEN_FILES.some((f) => path.endsWith(f));
  const violations: CalmViolation[] = [];
  // Blank out comments, keeping line numbers.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    const line = index + 1;
    const m = /^\s*(--[\w-]+|[a-z-]+)\s*:\s*(.+?);?\s*$/i.exec(raw);
    if (!m || raw.trimEnd().endsWith("{")) return;
    const property = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    const flag = (rule: CalmViolation["rule"]) => violations.push({ line, rule, text: raw.trim() });

    if (!tokenFile && RAW_COLOR.test(value)) flag("raw-color");
    if (property.startsWith("--")) return;

    if (SIDE.test(property)) {
      if (!/^(0|none|0 none|none 0)$/.test(value)) flag("side-accent");
      return;
    }
    if (BORDER.test(property) || property === "border-width") {
      if (/^(0|none)$/.test(value)) return;
      if (/\b(thin|medium|thick)\b/.test(value) || nonZeroLengths(value).length > 0) flag("border-width");
      else if (!value.includes("var(--rlx-border-width)") && property !== "border-width") flag("border-width");
      return;
    }
    if (property === "box-shadow" && /\binset\b/.test(value)) {
      flag("inset-bar");
      return;
    }
    if (property === "outline" || property === "outline-width") {
      if (!/^(0|none)$/.test(value) && !value.includes("var(--rlx-focus-width)")) flag("outline");
      return;
    }
    if (property === "font-size") {
      if (!/^(var\(--rlx-text-[\w-]+\)|inherit)$/.test(value)) flag("font-size");
      return;
    }
    if (/^border(-[a-z]+)*-radius$/.test(property)) {
      if (!/^(0|50%|var\(--rlx-radius-[\w-]+\)|inherit)$/.test(value)) flag("radius");
      return;
    }
    if (/^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)*$/.test(property)) {
      if (nonZeroLengths(value).length > 0) flag("spacing");
    }
  });
  return violations;
}
