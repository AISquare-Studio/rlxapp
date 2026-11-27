import { AgentActions, LastRun, ModeChip, StatusChip } from "../agents/AgentDetails.tsx";
import { useAgents } from "../agents/useAgents.ts";
import { connectorLabel } from "../core/connectors.ts";
import { useNow } from "../engine/hooks.ts";
import { MANAGER_ID, agentStatus, scheduleLabel, wakeLabel } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { CenterNav } from "../ui/CenterNav.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MoreMenu } from "../ui/MoreMenu.tsx";

/** Every agent: its state, next wake, last run and outcome, connectors, silent or loud, and its actions. */
export function Agents() {
  const { navigate, demo } = useApp();
  const { agents, running, simulateNine } = useAgents();
  const now = useNow(30_000);
  const hasBriefing = agents.some((a) => a.role === "briefing");
  return (
    <div className="agents-screen">
      <CenterNav
        title="Agents"
        actions={
          <>
            <button type="button" className="button button--primary" onClick={() => navigate({ name: "channel", id: MANAGER_ID })}>
              <Icon name="plus" size={16} /> New agent
            </button>
            {demo && hasBriefing ? <MoreMenu label="More actions for Agents" items={[{ label: "Simulate 9:00 (demo)", onSelect: simulateNine }]} /> : null}
          </>
        }
      />
      <ul className="agent-rows" aria-label="Your agents">
        {agents.map((agent) => {
          const status = agentStatus(agent, running.has(agent.id), now);
          return (
            <li key={agent.id} className="agent-row reveal-host" data-testid={`agent-row-${agent.id}`} aria-label={agent.name}>
              <button type="button" className="agent-row__who" onClick={() => navigate({ name: "channel", id: agent.id })} aria-label={`Open ${agent.name}'s channel`}>
                <Avatar letter={agent.avatar} status={status.kind} size="lg" />
                <span>
                  <strong>{agent.name}</strong>
                  <span className="muted agent-row__next">
                    {status.next !== undefined ? `Next wake ${wakeLabel(status.next, now)}` : status.kind === "running" ? "Running now" : "Won't wake until resumed"}
                  </span>
                </span>
              </button>
              <div className="agent-row__state">
                <StatusChip status={status} />
              </div>
              <AgentActions agent={agent} extra={[{ label: "Open channel", onSelect: () => navigate({ name: "channel", id: agent.id }) }]} />
              <details className="fold agent-row__details">
                <summary>Details</summary>
                <dl className="facts">
                  <dt>Does</dt>
                  <dd>{agent.purpose}</dd>
                  <dt>Schedule</dt>
                  <dd>
                    {scheduleLabel(agent.schedule)} · <ModeChip agent={agent} />
                  </dd>
                  <dt>Last run</dt>
                  <dd>
                    <LastRun agent={agent} now={now} />
                  </dd>
                  <dt>Connectors</dt>
                  <dd>
                    <ul className="connector-chips connector-chips--static" aria-label={`${agent.name}'s connectors`}>
                      {agent.connectors.map((c) => (
                        <li key={c} className="connector-chip">
                          {connectorLabel(c)}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </dl>
              </details>
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
