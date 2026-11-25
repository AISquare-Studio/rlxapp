import logo from "../assets/rlx-logo.svg?raw";

/** The logo's path data, read from rlx-logo.svg at build time (never redrawn). */
export const RLX_MARK_PATHS: readonly string[] = [...logo.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map(
  (match) => match[1] ?? "",
);

/** The logo's viewBox, `0 0 1606 940`. */
export const RLX_MARK_VIEWBOX = /viewBox="([^"]+)"/.exec(logo)?.[1] ?? "0 0 1606 940";
