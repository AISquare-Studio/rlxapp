import { RLX_MARK_PATHS, RLX_MARK_VIEWBOX } from "./mark.ts";

export interface RlxMarkProps {
  className?: string;
  /** Accessible name; the mark reads as the product name. */
  title?: string;
}

/** rlx's r\x mark. It is drawn in `currentColor`, so a theme can recolour it (by default `--rlx-mark`). */
export function RlxMark({ className, title = "rlx" }: RlxMarkProps) {
  return (
    <svg className={className} viewBox={RLX_MARK_VIEWBOX} role="img" aria-label={title}>
      {RLX_MARK_PATHS.map((d) => (
        <path key={d} d={d} fill="currentColor" />
      ))}
    </svg>
  );
}
