/**
 * The app core's agent orchestration, on the Engine interface. Waking an agent starts one engine
 * run; the AgentRunner follows every agent run (woken here, scheduled, or already running when
 * the app opens), turns its output into channel messages and cards, records the outcome, and the
 * agent sleeps again. Loud runs also refresh the Home briefing and fire a (mock) system
 * notification; silent runs only record their outcome and update widgets.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Briefing } from "../engine/fake/data.ts";
import { newRunId, useRuns } from "../engine/hooks.ts";
import { AGENT_PREFIX, BRIEFING_ROLE } from "../engine/runs.ts";
import type { RunSummary } from "../engine/types.ts";
import type { Agent } from "../state/agents.ts";
import { useApp } from "../state/context.ts";
import type { Card, Message } from "../state/model.ts";

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** The agent id an engine run belongs to, from its "agent:<id> <name>" prompt. */
export function agentOfRun(run: Pick<RunSummary, "title">): string | undefined {
  if (!run.title.startsWith(AGENT_PREFIX)) return undefined;
  return run.title.slice(AGENT_PREFIX.length).split(/\s/)[0] || undefined;
}

/** Ids of agents with a live engine run. */
export function useRunningAgents(): Set<string> {
  const runs = useRuns();
  return useMemo(
    () => new Set(runs.filter((r) => r.state === "running" || r.state === "queued").flatMap((r) => agentOfRun(r) ?? [])),
    [runs],
  );
}

export function useAgents() {
  const { engine, dispatch, state, toast } = useApp();
  const agents = state.settings.agents;
  const running = useRunningAgents();

  const wake = useCallback(
    async (agent: Agent) => {
      if (running.has(agent.id)) return;
      await engine.run({
        id: newRunId(),
        kind: "task",
        prompt: `${AGENT_PREFIX}${agent.id} ${agent.name}\n${agent.role === "briefing" ? `${BRIEFING_ROLE}\n` : ""}${agent.purpose}`,
        mount: { kind: "connectors", connectors: agent.connectors },
        needsConnectors: [],
        persist: agent.mode === "loud",
      });
    },
    [engine, running],
  );

  const setPaused = useCallback(
    (agent: Agent, paused: boolean) => {
      dispatch({ type: "agent-update", id: agent.id, patch: { state: paused ? "paused" : "asleep" } });
      toast(paused ? `${agent.name} is paused. It won't wake until you resume it.` : `${agent.name} resumed.`, "info");
    },
    [dispatch, toast],
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

/** Follows agent runs to their end and delivers what they produced. Renders nothing. */
export function AgentRunner() {
  const { engine, dispatch, state, now } = useApp();
  const runs = useRuns();
  /** Live subscriptions, by run id. */
  const followed = useRef(new Map<string, () => void>());
  // The latest agents and owner name, for the run callbacks.
  const latest = useRef({ agents: state.settings.agents, owner: state.settings.ownerName });
  useEffect(() => {
    latest.current = { agents: state.settings.agents, owner: state.settings.ownerName };
  }, [state.settings.agents, state.settings.ownerName]);

  useEffect(() => {
    const post = (channel: string, from: Message["from"], body: Pick<Message, "text" | "card">) =>
      dispatch({ type: "message-add", message: { id: nextId("m"), channel, from, at: now(), ...body } });

    const deliverBriefing = (agent: Agent, b: Briefing) => {
      const at = now();
      const priority: Extract<Card, { type: "priority" }> = { type: "priority", title: "Start of day", doNow: b.doNow, today: b.today, waiting: b.waiting };
      const first = latest.current.owner.split(" ")[0] ?? "";
      const channel = agent.id;
      if (agent.outputs.includes("channel")) {
        post(channel, "agent", { text: `Good morning ${first}. ${b.summary}` });
        post(channel, "agent", { card: priority });
        post(channel, "agent", { card: { type: "promise", ...b.promise } });
        post(channel, "agent", { card: { type: "checklist", title: "Before 10:00", items: b.checklist.map((text) => ({ text, done: false })) } });
        const draftId = nextId("d");
        dispatch({
          type: "draft-create",
          draft: {
            id: draftId,
            status: "pending",
            origin: "task",
            connector: b.draft.connector,
            destination: b.draft.to,
            subject: b.draft.subject,
            body: b.draft.body,
            createdAt: at,
            context: b.draft.context,
          },
        });
        post(channel, "agent", { text: "I drafted one reply. Nothing sends until you say so." });
        post(channel, "agent", { card: { type: "email-draft", draftId } });
        post(channel, "agent", {
          card: {
            type: "needs-context",
            id: nextId("nc"),
            question: b.needsContext.question,
            to: b.needsContext.to,
            subject: b.needsContext.subject,
            connector: b.needsContext.connector,
            sources: b.needsContext.sources,
            draftTemplate: b.needsContext.draftTemplate,
          },
        });
      }
      if (agent.outputs.includes("dashboard")) dispatch({ type: "briefing", at, card: priority });
      if (agent.mode === "loud") {
        dispatch({
          type: "notice",
          notice: { id: nextId("n"), channel, title: agent.name, body: `${b.doNow.length} to do now. First: ${b.doNow[0]?.text ?? ""}` },
        });
      }
      const outcome = `Posted the briefing: ${b.doNow.length} now, ${b.today.length} today, ${b.waiting.length} waiting on you`;
      dispatch({ type: "agent-update", id: agent.id, patch: { lastRun: { at, outcome, modelTurn: true } } });
    };

    const finish = (agentId: string, status: string, output: unknown) => {
      const agent = latest.current.agents.find((a) => a.id === agentId);
      if (!agent) return;
      const at = now();
      if (status !== "done") {
        dispatch({ type: "agent-update", id: agent.id, patch: { lastRun: { at, outcome: status === "cancelled" ? "Stopped" : "Failed", modelTurn: false } } });
        post(agent.id, "system", { text: `Woke and ${status === "cancelled" ? "was stopped" : "failed"}. Asleep again.` });
        return;
      }
      if (agent.role === "briefing" && output && typeof output === "object" && "doNow" in output) {
        deliverBriefing(agent, output as Briefing);
        return;
      }
      const result = (output ?? {}) as { outcome?: string; modelTurn?: boolean };
      const outcome = result.outcome ?? "Done";
      dispatch({ type: "agent-update", id: agent.id, patch: { lastRun: { at, outcome, modelTurn: result.modelTurn ?? false } } });
      post(agent.id, "system", { text: `Woke · ${outcome} · asleep again` });
      if (agent.mode === "loud") {
        dispatch({ type: "notice", notice: { id: nextId("n"), channel: agent.id, title: agent.name, body: outcome } });
      }
    };

    for (const run of runs) {
      const agentId = agentOfRun(run);
      if (!agentId || followed.current.has(run.id)) continue;
      // Runs that ended before the app opened are history, not news.
      if (run.state === "done" || run.state === "failed") {
        followed.current.set(run.id, () => {});
        continue;
      }
      const off = engine.attach(run.id, 1, ({ event }) => {
        if (event.type !== "finished") return;
        off();
        finish(agentId, event.status, event.output);
      });
      followed.current.set(run.id, off);
    }
  }, [runs, engine, dispatch, now]);

  useEffect(() => {
    const subs = followed.current;
    return () => {
      for (const off of subs.values()) off();
      subs.clear();
    };
  }, []);

  return null;
}
