import { AgentActions, LastRun, ModeChip, StatusChip } from "../agents/AgentDetails.tsx";
import { useAgents } from "../agents/useAgents.ts";
import { useNow } from "../engine/hooks.ts";
import { MANAGER_ID, agentStatus, scheduleLabel, wakeLabel } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { Icon } from "../ui/Icon.tsx";

/** Every agent: its state, next wake, last run and outcome, connectors, silent or loud, and its actions. */
export function Agents() {
  const { navigate, demo } = useApp();
  const { agents, running, simulateNine } = useAgents();
  const now = useNow(30_000);
  const hasBriefing = agents.some((a) => a.role === "briefing");
  return (
    <div className="agents-screen">
      <div className="screen-header">
        <div>
          <h1>Agents</h1>
          <p className="muted">They sleep until their schedule wakes them, run once, and sleep again. Silent runs only update widgets; loud runs notify you.</p>
        </div>
        <div className="button-row">
          {demo && hasBriefing ? (
            <button type="button" className="button" onClick={simulateNine} title="Demo control: fire the weekday 09:00 schedule now">
              <Icon name="play" size={16} /> Simulate 9:00 <span className="demo-tag">demo</span>
            </button>
          ) : null}
          <button type="button" className="button button--primary" onClick={() => navigate({ name: "channel", id: MANAGER_ID })}>
            <Icon name="plus" size={16} /> New agent
          </button>
        </div>
      </div>
      <ul className="agent-rows" aria-label="Your agents">
        {agents.map((agent) => {
          const status = agentStatus(agent, running.has(agent.id), now);
          return (
            <li key={agent.id} className="agent-row" data-testid={`agent-row-${agent.id}`} aria-label={agent.name}>
              <button type="button" className="agent-row__who" onClick={() => navigate({ name: "channel", id: agent.id })} aria-label={`Open ${agent.name}'s channel`}>
                <Avatar letter={agent.avatar} status={status.kind} size="lg" />
                <span>
                  <strong>{agent.name}</strong>
                  <span className="muted agent-row__purpose">{agent.purpose}</span>
                </span>
              </button>
              <div className="agent-row__facts">
                <div>
                  <StatusChip status={status} /> <ModeChip agent={agent} />
                </div>
                <div className="muted">
                  {scheduleLabel(agent.schedule)}
                  {status.next !== undefined ? ` · next wake ${wakeLabel(status.next, now)}` : ""}
                </div>
                <div>
                  <span className="muted">Last run </span>
                  <LastRun agent={agent} now={now} />
                </div>
                <ul className="connector-chips connector-chips--static" aria-label={`${agent.name}'s connectors`}>
                  {agent.connectors.map((c) => (
                    <li key={c} className="connector-chip">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
              <AgentActions agent={agent} />
            </li>
          );
        })}
      </ul>
      {!hasBriefing ? (
        <div className="empty-hint">
          <p>
            <strong>Tip:</strong> ask the manager for a morning briefing, e.g. “Every weekday at 9, give me a start of day briefing.”
          </p>
          <button type="button" className="button" onClick={() => navigate({ name: "channel", id: MANAGER_ID })}>
            Open the manager
          </button>
        </div>
      ) : null}
    </div>
  );
}
