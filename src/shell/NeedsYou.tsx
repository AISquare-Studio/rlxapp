import { useState } from "react";
import type { PendingItem } from "../core/pending.ts";
import { useApp } from "../state/context.ts";

/**
 * What waits on the owner, in place on Home: a quiet one-line fold, shown only when something
 * does. It reads the core's Pending list: run questions are answered right here; drafts link to
 * Approvals.
 */
export function NeedsYou() {
  const { state, navigate } = useApp();
  const needs = state.pending.filter((item) => item.kind === "question" && item.status === "open");
  const drafts = state.drafts.length;
  if (!needs.length && !drafts) return null;
  const parts = [
    needs.length ? `${needs.length} question${needs.length === 1 ? "" : "s"}` : null,
    drafts ? `${drafts} draft${drafts === 1 ? "" : "s"} to approve` : null,
  ].filter(Boolean);
  return (
    <details className="fold needs-you-fold" data-testid="needs-you">
      <summary>Needs you · {parts.join(", ")}</summary>
      <div className="needs-you-fold__body">
        {needs.map((item) => (
          <RunQuestion key={item.id} item={item} />
        ))}
        {drafts ? (
          <button type="button" className="button button--sm" onClick={() => navigate({ name: "approvals", tab: "drafts" })}>
            Review {drafts} draft{drafts === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>
    </details>
  );
}

function RunQuestion({ item }: { item: PendingItem }) {
  const { core, toast } = useApp();
  const [answer, setAnswer] = useState("");
  return (
    <div className="card-msg needs-context" data-testid="run-question">
      <div className="card-msg__head">
        <span className="badge badge--warning">Needs your answer</span>
        <strong>{item.title}</strong>
      </div>
      <p>{item.text}</p>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          const text = answer.trim();
          if (!text) return;
          void core.answerPending(item.id, text).then(() => toast("Thanks. Picking it up again.", "success"));
          setAnswer("");
        }}
      >
        <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" aria-label={`Answer: ${item.text}`} />
        <button type="submit" className="button button--sm button--primary" disabled={!answer.trim()}>
          Reply
        </button>
      </form>
    </div>
  );
}
