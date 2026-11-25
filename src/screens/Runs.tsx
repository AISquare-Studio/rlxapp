import { useState } from "react";
import { newRunId, useRunEvents, useRuns } from "../engine/hooks.ts";
import { STATE_LABEL, taskRuns } from "../engine/runs.ts";
import type { RunState } from "../engine/types.ts";
import { useApp } from "../state/context.ts";
import { DevNav } from "./Developer.tsx";
import { Icon } from "../ui/Icon.tsx";

export function StateChip({ state }: { state: RunState }) {
  return <span className={`state state--${state}`}>{STATE_LABEL[state]}</span>;
}

const ORDER: RunState[] = ["needs-you", "running", "queued", "failed", "done"];

/** Developer mode: every run with its raw log, including agents' scheduled runs. */
export function Runs() {
  const { screen } = useApp();
  const runId = screen.name === "runs" ? screen.runId : undefined;
  return runId ? <RunDetail runId={runId} /> : <RunOverview />;
}

function RunOverview() {
  const { engine, navigate, state, toast } = useApp();
  const runs = taskRuns(useRuns());
  const [prompt, setPrompt] = useState("");
  const start = async () => {
    const title = prompt.trim();
    if (!title) return;
    const id = await engine.run({
      id: newRunId(),
      kind: "task",
      prompt: title,
      mount: { kind: "connectors", connectors: ["claude.ai Slack", "claude.ai Gmail"] },
      needsConnectors: [],
      persist: true,
    });
    setPrompt("");
    toast(`${state.settings.agentName} queued “${title}”`, "success");
    navigate({ name: "runs", runId: id });
  };
  return (
    <div>
      <DevNav current="runs" />
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Start a task run…" aria-label="New task" />
        <button type="submit" className="button button--primary" disabled={!prompt.trim()}>
          <Icon name="plus" size={16} /> New task
        </button>
      </form>
      {ORDER.map((group) => {
        const items = runs.filter((r) => r.state === group);
        if (items.length === 0) return null;
        return (
          <section key={group} className="task-group" aria-label={STATE_LABEL[group]}>
            <h2 className="task-group__title">
              {STATE_LABEL[group]} <span className="muted">{items.length}</span>
            </h2>
            <ul className="task-list">
              {items.map((run) => (
                <li key={run.id}>
                  <button type="button" className="task-row" onClick={() => navigate({ name: "runs", runId: run.id })}>
                    <StateChip state={run.state} />
                    <span className="task-row__title">{run.title}</span>
                    <span className="muted task-row__time">{new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const { engine, toast, navigate } = useApp();
  const runs = useRuns();
  const run = runs.find((r) => r.id === runId);
  const events = useRunEvents(runId);
  const [reply, setReply] = useState("");

  if (!run) return <p className="muted">Loading run…</p>;
  const question = run.state === "needs-you" ? [...events].reverse().find((e) => e.event.type === "question") : undefined;
  return (
    <div className="task-detail">
      <DevNav current="runs" title={run.title} crumbs={[{ label: "Runs", onSelect: () => navigate({ name: "runs" }) }]} />
      <div className="run-meta">
        <p className="muted">
          <StateChip state={run.state} /> Started {new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          {run.failureReason ? <span className="error-text"> · {run.failureReason}</span> : null}
        </p>
        <div className="button-row">
          {run.state === "running" || run.state === "queued" || run.state === "needs-you" ? (
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                void engine.cancel(runId).then(() => toast("Run cancelled", "info"));
              }}
            >
              <Icon name="stop" size={16} /> Cancel
            </button>
          ) : null}
          {run.state === "failed" ? (
            <button type="button" className="button" onClick={() => void engine.resume(runId)}>
              <Icon name="reset" size={16} /> Retry
            </button>
          ) : null}
        </div>
      </div>

      {question && question.event.type === "question" ? (
        <form
          className="needs-you-box"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            void engine.resume(runId, reply.trim());
            setReply("");
          }}
        >
          <p>
            <strong>Needs you:</strong> {question.event.text}
          </p>
          <div className="composer">
            <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Your answer" aria-label="Answer" />
            <button type="submit" className="button button--primary" disabled={!reply.trim()}>
              Answer
            </button>
          </div>
        </form>
      ) : null}

      <h2 className="section-title">Log</h2>
      <ol className="log" aria-live="polite" data-testid="task-log">
        {events.map(({ seq, event }) => (
          <li key={seq} className={`log__line log__line--${event.type}`}>
            <span className="log__seq">{String(seq).padStart(2, "0")}</span>
            <span>
              {event.type === "started" ? "Started" : null}
              {event.type === "text" ? event.delta : null}
              {event.type === "tool_call" ? `Calling ${event.call.tool}` : null}
              {event.type === "tool_result" ? `Result from ${event.tool}` : null}
              {event.type === "rate_limited" ? "Rate limited; waiting" : null}
              {event.type === "question" ? `Asked: ${event.text}` : null}
              {event.type === "finished" ? `Finished: ${event.status}${event.reason ? ` (${event.reason})` : ""}` : null}
            </span>
          </li>
        ))}
        <li key={`end-${events.length}`} ref={(el) => el?.scrollIntoView?.({ block: "nearest" })} aria-hidden="true" />
      </ol>
    </div>
  );
}
