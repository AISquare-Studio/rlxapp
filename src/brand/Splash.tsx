import { RlxMark } from "./RlxMark.tsx";

/** The splash and loading screen: the r\x mark on the ground, while the engine says hello. */
export function Splash({ label = "Starting rlx…" }: { label?: string }) {
  return (
    <div className="splash" role="status" aria-live="polite" data-testid="splash">
      <RlxMark className="splash__mark" />
      <p className="splash__label">{label}</p>
    </div>
  );
}
