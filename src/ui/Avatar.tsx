import type { AgentStatusKind } from "../state/agents.ts";

/** An agent's letter-mark, with a status dot (green only while running). */
export function Avatar({ letter, status, manager, size = "md" }: { letter: string; status?: AgentStatusKind; manager?: boolean; size?: "md" | "lg" }) {
  return (
    <span className={`avatar avatar--${size}${manager ? " avatar--manager" : ""}`} aria-hidden="true">
      {letter}
      {status ? <span className={`avatar__status avatar__status--${status}`} /> : null}
    </span>
  );
}
