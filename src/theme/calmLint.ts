/**
 * The calm-design lint (rule-calm-design.md): component CSS uses design tokens only, and draws
 * no accent bars. It parses real CSS with postcss, so one-line rules, several declarations on a
 * line and values split across lines are all seen. `npm run lint` runs it on every stylesheet
 * (scripts/lint-calm.mjs), and so does CI; vitest runs it against fixtures.
 *
 * Outside the token file it fails on:
 *   - border widths other than `var(--rlx-border-width)`, including thin/medium/thick;
 *   - accent bars: any visible border-left/right (or inline-start/end), side-only border-width,
 *     inset or hard-edged box-shadows, pseudo-element stripes, linear gradients, and thick or
 *     coloured underlines;
 *   - border, outline and underline colours outside the allow-list;
 *   - raw colours (hex, colour functions, every CSS named colour);
 *   - redefining a `--rlx-*` token, and custom properties that smuggle any of the above;
 *   - font sizes, radii, spacing and shadows that aren't tokens.
 */
import { parse, type Declaration, type Rule } from "postcss";

export type CalmRule =
  | "border-width"
  | "side-accent"
  | "shadow"
  | "pseudo-bar"
  | "gradient"
  | "underline"
  | "border-color"
  | "raw-color"
  | "token-override"
  | "font-size"
  | "radius"
  | "spacing"
  | "outline"
  | "inline-style";

export interface CalmViolation {
  line: number;
  rule: CalmRule;
  text: string;
}

/** Files that define the tokens, where raw values belong (repo-relative, with '/'). */
export const TOKEN_FILES = ["src/theme/tokens.css"];

/** A path with '/' separators, whatever the OS gave (Windows gives 'src\theme\tokens.css'). */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Whether `path` (absolute or repo-relative, any separator) is a token file. */
export function isTokenFile(path: string): boolean {
  const posix = toPosixPath(path);
  return TOKEN_FILES.some((f) => posix === f || posix.endsWith(`/${f}`));
}

/**
 * What the lint checks among repo-relative paths (any separator): stylesheets and components
 * under src/, minus test fixtures and tests. Returned with '/' separators, sorted.
 */
export function lintTargets(paths: string[]): { css: string[]; tsx: string[] } {
  const all = paths.map(toPosixPath).filter((p) => !p.includes("/fixtures/"));
  return {
    css: all.filter((p) => p.endsWith(".css")).sort(),
    tsx: all.filter((p) => p.endsWith(".tsx") && !p.endsWith(".test.tsx")).sort(),
  };
}

/** Every CSS named colour (CSS Color 4), plus the system-colour keywords that read as colours. */
const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
    "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
    "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue " +
    "mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas " +
    "canvastext field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem selecteditemtext visitedtext"
  ).split(" "),
);
const COLOR_FUNCTION = /(?:^|[^\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const HEX = /#[0-9a-f]{3,8}\b/i;
/** Properties whose values are names, not colours ("tan", "gold" … can be animation names). */
const NAME_PROPS = /^(font|font-family|animation|animation-name|grid-template-areas|grid-area|content|transition|transition-property|will-change|counter-reset|counter-increment|list-style-type|quotes|view-transition-name)$/;

/** Border colours a component may use: the one border colour, its stronger neutral, selection, cutouts. */
const BORDER_COLORS = new Set([
  "var(--rlx-border-color)",
  "var(--rlx-border-strong)",
  "var(--rlx-selection-border)",
  "var(--rlx-surface)",
  "transparent",
  "inherit",
]);
const UNDERLINE_COLORS = new Set(["currentcolor", "var(--rlx-border-color)", "var(--rlx-border-strong)", "inherit"]);
const SIDE = /^border-(?:left|right|inline|inline-start|inline-end)(?:-width|-style|-color)?$/;
const BORDER = /^border(?:-(?:top|bottom|block|block-start|block-end))?$/;
const BORDER_WIDTH = /^border(?:-(?:top|bottom|block|block-start|block-end))?-width$/;
const BORDER_COLOR = /^border(?:-(?:top|bottom|block|block-start|block-end))?-color$/;
const STYLE_WORDS = new Set(["solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset", "hidden", "none"]);
/** A length with a unit. Unitless numbers (calc() multipliers) aren't lengths. */
const LENGTH = /(?<![\w-])-?\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|pt|ch|ex)(?![\w-])/g;
const ONE_LENGTH = /^-?\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|pt|ch|ex)$/;

/** Top-level comma-separated parts of a value (commas inside functions don't split). */
function topLevel(value: string, separator: "," | " "): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    const splits = separator === "," ? ch === "," : /\s/.test(ch);
    if (splits && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function stripStrings(value: string): string {
  return value.replace(/"[^"]*"|'[^']*'/g, " ").replace(/url\([^)]*\)/gi, " ");
}

function nonZeroLengths(value: string): string[] {
  const stripped = value.replace(/var\([^()]*\)/g, " ");
  return [...stripped.matchAll(LENGTH)].map((m) => m[0]).filter((n) => Number.parseFloat(n) !== 0);
}

function hasRawColor(property: string, value: string): boolean {
  const v = stripStrings(value);
  if (HEX.test(v) || COLOR_FUNCTION.test(v)) return true;
  if (NAME_PROPS.test(property)) return false;
  return v
    .toLowerCase()
    .replace(/var\([^()]*\)/g, " ")
    .split(/[^a-z-]+/)
    .some((word) => NAMED_COLORS.has(word));
}

function isZero(part: string): boolean {
  return /^(0|0px|none)$/.test(part);
}

/** A border shorthand's colour part, if it has one. */
function borderColorPart(value: string): string | null {
  const parts = topLevel(value, " ").filter((p) => !STYLE_WORDS.has(p.toLowerCase()) && p !== "var(--rlx-border-width)" && !isZero(p));
  return parts.find((p) => !ONE_LENGTH.test(p) && !/^(thin|medium|thick)$/i.test(p)) ?? null;
}

function px(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(-?\d*\.?\d+)px$/.exec(value.trim());
  return m ? Number(m[1]) : null;
}

/** Lints one stylesheet. `path` decides whether raw values are allowed (the token file). */
export function lintCalm(css: string, path: string): CalmViolation[] {
  const tokenFile = isTokenFile(path);
  const violations: CalmViolation[] = [];
  const root = parse(css, { from: path });
  const flag = (node: Declaration | Rule, rule: CalmRule) =>
    violations.push({ line: node.source?.start?.line ?? 0, rule, text: node.toString().replace(/\s+/g, " ").trim().slice(0, 120) });

  if (tokenFile) return violations;

  root.walkDecls((decl) => {
    const property = decl.prop.toLowerCase();
    const value = decl.value.trim();
    if (property.startsWith("--")) {
      if (property.startsWith("--rlx-")) flag(decl, "token-override");
      if (hasRawColor(property, value)) flag(decl, "raw-color");
      if (/\binset\b/i.test(value)) flag(decl, "shadow");
      if (/linear-gradient\(/i.test(value)) flag(decl, "gradient");
      return;
    }
    if (hasRawColor(property, value)) flag(decl, "raw-color");

    if (SIDE.test(property)) {
      if (!/^(0|none|0 none|none 0)$/i.test(value)) flag(decl, "side-accent");
      return;
    }
    if (BORDER.test(property)) {
      if (/^(0|none)$/i.test(value)) return;
      if (/\b(thin|medium|thick)\b/i.test(value) || nonZeroLengths(value).length > 0 || !value.includes("var(--rlx-border-width)")) {
        flag(decl, "border-width");
      }
      const color = borderColorPart(value);
      if (color && !BORDER_COLORS.has(color.toLowerCase())) flag(decl, "border-color");
      return;
    }
    if (BORDER_WIDTH.test(property) || property === "border-width") {
      const parts = topLevel(value, " ");
      if (parts.some((p) => !isZero(p) && p !== "var(--rlx-border-width)")) flag(decl, "border-width");
      if (property === "border-width" && parts.length > 1) {
        const [top = "0", right = top, bottom = top, left = right] = parts;
        const sideOnly = left !== right || ((!isZero(left) || !isZero(right)) && (isZero(top) || isZero(bottom)));
        if (sideOnly) flag(decl, "side-accent");
      }
      return;
    }
    if (BORDER_COLOR.test(property) || property === "border-color") {
      if (topLevel(value, " ").some((p) => !BORDER_COLORS.has(p.toLowerCase()))) flag(decl, "border-color");
      return;
    }
    if (property === "box-shadow" || property === "filter") {
      const shadows = property === "filter" ? (value.match(/drop-shadow\(/gi) ?? []) : topLevel(value, ",");
      if (property === "box-shadow" && /^none$/i.test(value)) return;
      if (shadows.some((s) => !/^var\(--rlx-shadow-[\w-]+\)$/.test(s))) flag(decl, "shadow");
      return;
    }
    if (property === "outline" || property === "outline-width" || property === "outline-color") {
      if (/^(0|none)$/i.test(value)) return;
      const allowed = property === "outline" ? /^var\(--rlx-focus-width\) solid var\(--rlx-focus-color\)$/ : /^var\(--rlx-focus-(width|color)\)$/;
      if (!allowed.test(value)) flag(decl, "outline");
      return;
    }
    if (/^background(-image)?$/.test(property) && /linear-gradient\(/i.test(value)) {
      flag(decl, "gradient");
      return;
    }
    if (property === "text-decoration" || property === "text-decoration-thickness" || property === "text-decoration-color") {
      const lengths = nonZeroLengths(value).filter((l) => l !== "1px");
      const colorParts = topLevel(value, " ").filter((p) => !/^(underline|overline|line-through|none|solid|dotted|dashed|wavy|double|auto|from-font|1px)$/i.test(p));
      const badColor = colorParts.some((p) => !UNDERLINE_COLORS.has(p.toLowerCase()) && p !== "var(--rlx-border-width)");
      if (lengths.length > 0 || badColor) flag(decl, "underline");
      return;
    }
    if (property === "font-size") {
      if (!/^(var\(--rlx-text-[\w-]+\)|inherit)$/.test(value)) flag(decl, "font-size");
      return;
    }
    if (/^border(-[a-z]+)*-radius$/.test(property)) {
      if (!/^(0|50%|var\(--rlx-radius-[\w-]+\)|inherit)$/.test(value)) flag(decl, "radius");
      return;
    }
    if (/^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)*$/.test(property)) {
      if (nonZeroLengths(value).length > 0) flag(decl, "spacing");
    }
  });

  // Pseudo-element stripes: a thin, long ::before/::after with a fill draws a bar.
  root.walkRules((rule) => {
    if (!/::?(before|after)\b/.test(rule.selector)) return;
    const decls = new Map<string, string>();
    rule.walkDecls((d) => {
      decls.set(d.prop.toLowerCase(), d.value.trim());
    });
    const fill = decls.get("background") ?? decls.get("background-color");
    if (!fill || /^(none|transparent)$/i.test(fill)) return;
    const w = px(decls.get("width"));
    const h = px(decls.get("height"));
    const tall = decls.get("height") === "100%" || (decls.has("top") && decls.has("bottom"));
    const wide = decls.get("width") === "100%" || (decls.has("left") && decls.has("right"));
    const thin = (n: number | null) => n !== null && n <= 4;
    const stripe =
      (thin(w) && (tall || (h !== null && h >= 3 * (w ?? 1)))) || (thin(h) && (wide || (w !== null && w >= 3 * (h ?? 1))));
    if (stripe) flag(rule, "pseudo-bar");
  });

  return violations.sort((a, b) => a.line - b.line);
}

/**
 * TSX inline styles may set layout only (a width, a progress variable): colours, borders,
 * shadows, type and spacing come from the stylesheet's tokens.
 */
export function lintInlineStyles(tsx: string, path: string): CalmViolation[] {
  const violations: CalmViolation[] = [];
  const forbidden = /^(border\w*|boxShadow|outline\w*|color|background\w*|fontSize|padding\w*|margin\w*|textDecoration\w*|gap)$/;
  for (const match of tsx.matchAll(/style=\{\{([^{}]*)\}\}/g)) {
    const keys = [...(match[1] ?? "").matchAll(/(?:^|,)\s*\[?["']?([\w-]+)["']?\]?\s*:/g)].map((m) => m[1] ?? "");
    if (keys.some((k) => forbidden.test(k))) {
      const line = tsx.slice(0, match.index).split("\n").length;
      violations.push({ line, rule: "inline-style", text: `${path}: ${match[0].slice(0, 100)}` });
    }
  }
  return violations;
}
