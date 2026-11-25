import { useEffect, useState } from "react";
import type { BoardTask, FleetAgent } from "../engine/types.ts";
import { useApp } from "../state/context.ts";
import { Icon } from "../ui/Icon.tsx";

const AGENT_STATE: Record<FleetAgent["state"], string> = {
  live: "Live",
  waiting: "Waiting",
  paused: "Paused",
  exited: "Exited",
  lost: "Lost",
};

function useFleet(): FleetAgent[] {
  const { developer } = useApp();
  const [agents, setAgents] = useState<FleetAgent[]>([]);
  useEffect(() => {
    let active = true;
    void developer.fleet().then((next) => active && setAgents(next));
    return () => {
      active = false;
    };
  }, [developer]);
  return agents;
}

function OpenInTerminal() {
  const { developer, toast } = useApp();
  return (
    <button
      type="button"
      className="button"
      onClick={() => {
        void developer.openInTerminal().then(() => toast("Opening rlx in your terminal (rlx ui)…", "info"));
      }}
    >
      <Icon name="terminal" size={16} /> Open in terminal (rlx TUI)
    </button>
  );
}

export function Fleet() {
  const { navigate } = useApp();
  const agents = useFleet();
  return (
    <div>
      <div className="screen-header">
        <div>
          <h1>Fleet</h1>
          <p className="muted">Your rlx agents across projects. Developer mode.</p>
        </div>
        <OpenInTerminal />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Role</th>
            <th scope="col">Project</th>
            <th scope="col">State</th>
            <th scope="col">Account</th>
            <th scope="col">Task</th>
            <th scope="col">
              <span className="visually-hidden">Pane</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td>{a.label}</td>
              <td>{a.role}</td>
              <td>{a.project}</td>
              <td>
                <span className={`agent-state agent-state--${a.state}`}>{AGENT_STATE[a.state]}</span>
              </td>
              <td>{a.account}</td>
              <td className="muted">{a.task ?? "—"}</td>
              <td>
                <button type="button" className="button button--sm" onClick={() => navigate({ name: "panes", agentId: a.id })}>
                  View pane
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const COLUMNS: BoardTask["status"][] = ["todo", "doing", "review", "blocked", "done"];
const COLUMN_LABEL: Record<BoardTask["status"], string> = { todo: "To do", doing: "Doing", review: "Review", blocked: "Blocked", done: "Done" };

export function Board() {
  const { developer } = useApp();
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  useEffect(() => {
    let active = true;
    void developer.board().then((next) => active && setTasks(next));
    return () => {
      active = false;
    };
  }, [developer]);
  return (
    <div>
      <div className="screen-header">
        <div>
          <h1>Board</h1>
          <p className="muted">The team board for the web project. Developer mode.</p>
        </div>
        <OpenInTerminal />
      </div>
      <div className="kanban">
        {COLUMNS.map((col) => (
          <section key={col} className="kanban__col" aria-label={COLUMN_LABEL[col]}>
            <h2>
              {COLUMN_LABEL[col]} <span className="muted">{tasks.filter((t) => t.status === col).length}</span>
            </h2>
            {tasks
              .filter((t) => t.status === col)
              .map((t) => (
                <div key={t.id} className="kanban__card">
                  <div>{t.title}</div>
                  {t.owner ? <div className="muted">@{t.owner}</div> : null}
                </div>
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}

export function Panes() {
  const { screen, developer, navigate } = useApp();
  const agents = useFleet();
  const selected = (screen.name === "panes" ? screen.agentId : undefined) ?? "a2";
  const [text, setText] = useState("");
  useEffect(() => developer.watchPane(selected, setText), [developer, selected]);
  return (
    <div>
      <div className="screen-header">
        <div>
          <h1>Panes</h1>
          <p className="muted">Read-only views of your agents' terminals. Developer mode.</p>
        </div>
        <OpenInTerminal />
      </div>
      <div className="tabs" role="tablist" aria-label="Agent panes">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            role="tab"
            aria-selected={selected === a.id}
            className={`tab${selected === a.id ? " is-active" : ""}`}
            onClick={() => navigate({ name: "panes", agentId: a.id })}
          >
            {a.label}
          </button>
        ))}
      </div>
      <pre className="terminal" aria-label="Pane output (read-only)" data-testid="pane-output" tabIndex={0}>
        {text}
      </pre>
    </div>
  );
}
