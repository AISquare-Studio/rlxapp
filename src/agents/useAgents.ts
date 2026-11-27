/**
 * The screens' view of agents. Definitions, waking and pausing are the core's; it also follows
 * each agent's run to its end and delivers what it produced (messages, cards, drafts, the Home
 * briefing, a notification for loud runs).
 */
import { useCallback, useMemo } from "react";
import type { Agent } from "../state/agents.ts";
import { useApp } from "../state/context.ts";

/** Ids of agents whose job has a live run. */
export function useRunningAgents(): Set<string> {
  const { state } = useApp();
  return useMemo(() => new Set(state.runningAgents), [state.runningAgents]);
}

export function useAgents() {
  const { core, state, toast } = useApp();
  const agents = state.agents;
  const running = useRunningAgents();

  const wake = useCallback((agent: Agent) => core.wake(agent.id), [core]);

  const setPaused = useCallback(
    (agent: Agent, paused: boolean) => {
      void core.setPaused(agent.id, paused);
      toast(paused ? `${agent.name} is paused. It won't wake until you resume it.` : `${agent.name} resumed.`, "info");
    },
    [core, toast],
  );

  const simulateNine = useCallback(() => {
    const agent = agents.find((a) => a.role === "briefing");
    if (!agent) {
      toast("Create Start of day with the manager first.", "warning");
      return;
    }
    if (agent.state === "paused") {
      toast("Start of day is paused. Resume it to run.", "warning");
      return;
    }
    void wake(agent);
  }, [agents, wake, toast]);

  return { agents, running, wake, setPaused, simulateNine };
}
