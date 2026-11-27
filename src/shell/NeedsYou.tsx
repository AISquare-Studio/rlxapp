import { useState } from "react";
import { useRunEvents, useRuns } from "../engine/hooks.ts";
import { taskRuns } from "../engine/runs.ts";
import { useApp } from "../state/context.ts";

/**
 * What waits on the owner, in place on Home: a quiet one-line fold, shown only when something
 * does. Questions are answered right here; drafts link to Approvals.
 */
export function NeedsYou() {
  const { state, navigate } = useApp();
  const needs = taskRuns(useRuns()).filter((r) => r.state === "needs-you");
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
        {needs.map((run) => (
          <RunQuestion key={run.id} runId={run.id} title={run.title} />
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

function RunQuestion({ runId, title }: { runId: string; title: string }) {
  const { engine, toast } = useApp();
  const events = useRunEvents(runId);
  const [answer, setAnswer] = useState("");
  const question = [...events].reverse().find((e) => e.event.type === "question")?.event;
  if (!question || question.type !== "question") return null;
  return (
    <div className="card-msg needs-context" data-testid="run-question">
      <div className="card-msg__head">
        <span className="badge badge--warning">Needs your answer</span>
        <strong>{title}</strong>
      </div>
      <p>{question.text}</p>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          const text = answer.trim();
          if (!text) return;
          void engine.resume(runId, text).then(() => toast("Thanks. Picking it up again.", "success"));
          setAnswer("");
        }}
      >
        <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" aria-label={`Answer: ${question.text}`} />
        <button type="submit" className="button button--sm button--primary" disabled={!answer.trim()}>
          Reply
        </button>
      </form>
    </div>
  );
}
