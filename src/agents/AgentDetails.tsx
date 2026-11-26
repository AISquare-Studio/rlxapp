import { useState } from "react";
import { AgentEditor } from "../chat/AgentEditor.tsx";
import { useNow } from "../engine/hooks.ts";
import { agentStatus, avatarFor, scheduleLabel, wakeLabel, type Agent, type AgentStatus } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import type { Proposal } from "../state/model.ts";
import { Icon } from "../ui/Icon.tsx";
import type { MenuItem } from "../ui/MoreMenu.tsx";
import { Modal } from "../ui/Modal.tsx";
import { MoreMenu } from "../ui/MoreMenu.tsx";
import { ago } from "../widgets/time.ts";
import { useAgents } from "./useAgents.ts";

const OUTPUT_LABEL = { channel: "Channel message", widget: "Widget", dashboard: "Home dashboard" } as const;

export function StatusChip({ status }: { status: AgentStatus }) {
  return <span className={`agent-state agent-state--${status.kind}`}>{status.label}</span>;
}

export function ModeChip({ agent }: { agent: Agent }) {
  return (
    <span className={`mode-chip mode-chip--${agent.mode}`} title={agent.mode === "silent" ? "Updates widgets and the dashboard only" : "Notifies you and posts in its channel"}>
      <Icon name={agent.mode === "silent" ? "moon" : "bell"} size={12} /> {agent.mode === "silent" ? "Silent" : "Loud"}
    </span>
  );
}

export function LastRun({ agent, now }: { agent: Agent; now: number }) {
  if (!agent.lastRun) return <span className="muted">Hasn't run yet</span>;
  const { outcome, modelTurn } = agent.lastRun;
  // The chip says whether Claude was used, unless the outcome already says so.
  const saysSo = /claude/i.test(outcome);
  return (
    <span className="last-run">
      <span className="muted">{ago(now, agent.lastRun.at)}:</span> {outcome}
      {saysSo ? null : <span className={`turn-chip${modelTurn ? " turn-chip--model" : ""}`}>{modelTurn ? "model turn" : "no Claude usage"}</span>}
    </span>
  );
}

/** Wake now / Pause (Resume) / Edit. */
export function AgentActions({ agent, compact, extra = [] }: { agent: Agent; compact?: boolean; extra?: MenuItem[] }) {
  const { wake, setPaused, running, agents } = useAgents();
  const { dispatch, toast } = useApp();
  const [editing, setEditing] = useState(false);
  const isRunning = running.has(agent.id);
  const size = compact ? " button--sm" : "";
  return (
    <div className="button-row agent-actions">
      <button type="button" className={`button${size}`} disabled={isRunning || agent.state === "paused"} onClick={() => void wake(agent)} aria-label={`Wake ${agent.name} now`}>
        <Icon name="play" size={14} /> Wake now
      </button>
      <MoreMenu
        label={`More actions for ${agent.name}`}
        items={[
          { label: agent.state === "paused" ? "Resume" : "Pause", onSelect: () => setPaused(agent, agent.state !== "paused") },
          { label: "Edit", onSelect: () => setEditing(true) },
          ...extra,
        ]}
      />
      {editing ? (
        <EditAgentDialog
          agent={agent}
          onClose={() => setEditing(false)}
          onSave={(next) => {
            dispatch({ type: "agent-update", id: agent.id, patch: { ...next, avatar: avatarFor(next.name, agents.filter((a) => a.id !== agent.id)) } });
            setEditing(false);
            toast(`Saved ${next.name}`, "success");
          }}
        />
      ) : null}
    </div>
  );
}

function EditAgentDialog({ agent, onClose, onSave }: { agent: Agent; onClose: () => void; onSave: (next: Proposal) => void }) {
  const [value, setValue] = useState<Proposal>({
    role: agent.role,
    purpose: agent.purpose,
    name: agent.name,
    connectors: agent.connectors,
    schedule: agent.schedule,
    mode: agent.mode,
    outputs: agent.outputs,
  });
  return (
    <Modal
      title={`Edit ${agent.name}`}
      onClose={onClose}
      footer={
        <div className="button-row">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button button--primary" disabled={!value.name.trim() || !value.connectors.length} onClick={() => onSave(value)}>
            Save
          </button>
        </div>
      }
    >
      <AgentEditor value={value} onChange={setValue} idPrefix={`edit-${agent.id}`} />
    </Modal>
  );
}

/** An agent's details, in place under its channel's navigation line (which already names it). */
export function AgentDetails({ agent }: { agent: Agent }) {
  const { running } = useAgents();
  const now = useNow(30_000);
  const status = agentStatus(agent, running.has(agent.id), now);
  return (
    <div className="agent-details" data-testid="agent-details">
      <p className="muted">{agent.purpose}</p>
      <p>
        <ModeChip agent={agent} />
      </p>
      <dl className="facts">
        <dt>Schedule</dt>
        <dd>{scheduleLabel(agent.schedule)}</dd>
        <dt>Next wake</dt>
        <dd>{status.next !== undefined ? wakeLabel(status.next, now) : status.kind === "running" ? "Running now" : "Paused"}</dd>
        <dt>Last run</dt>
        <dd>
          <LastRun agent={agent} now={now} />
        </dd>
        <dt>Connectors</dt>
        <dd>
          <ul className="connector-chips connector-chips--static">
            {agent.connectors.map((c) => (
              <li key={c} className="connector-chip">
                {c}
              </li>
            ))}
          </ul>
        </dd>
        <dt>Output</dt>
        <dd>{agent.outputs.map((o) => OUTPUT_LABEL[o]).join(", ")}</dd>
      </dl>
    </div>
  );
}
