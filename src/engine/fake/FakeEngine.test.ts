import { describe, expect, it } from "vitest";
import { BRIEFING_SCHEMA, isAgentRun, isChatTurn, taskRuns } from "../runs.ts";
import type { RunEvent, RunRequest } from "../types.ts";
import { FakeEngine } from "./FakeEngine.ts";

function finished(engine: FakeEngine, id: string): Promise<Extract<RunEvent, { type: "finished" }>> {
  return new Promise((resolve) => {
    const off = engine.attach(id, 1, ({ event }) => {
      if (event.type === "finished") {
        off();
        resolve(event);
      }
    });
  });
}

const mount = { kind: "no_tools" } as const;
const base = { kind: "task" as const, mount, needsConnectors: [] as string[], persist: true };

/** An agent's job run, a chat turn with that agent, and an owner's task. */
function requests(): Record<"job" | "chat" | "task", RunRequest> {
  return {
    job: { ...base, id: "brief", prompt: "Start of day\nGathers outcomes.", jobId: "job-start-of-day", agentId: "start-of-day", loud: true, outputSchema: BRIEFING_SCHEMA },
    chat: { ...base, id: "chat", prompt: "hello", agentId: "start-of-day" },
    task: { ...base, id: "task", prompt: "Draft the launch email" },
  };
}

describe("FakeEngine scheduling", () => {
  it("never lets the task scheduler finish an agent run or a chat turn (a race seen on slow CI)", async () => {
    const engine = new FakeEngine({ stepMs: 10, seed: false });
    const { job, chat, task } = requests();
    const briefing = await engine.run(job);
    const turn = await engine.run(chat);
    // A plain task schedules immediately, while the two above are still queued on their timers.
    await engine.run(task);
    const [b, c] = await Promise.all([finished(engine, briefing), finished(engine, turn)]);
    expect(b.status).toBe("done");
    expect(b.output).toMatchObject({ doNow: expect.any(Array), today: expect.any(Array) });
    expect(c.output).toMatchObject({ reply: expect.any(String) });
  });
});

describe("run identity (F4)", () => {
  it("carries the job, the agent, loud and the account on each run, never in its title", async () => {
    const engine = new FakeEngine({ stepMs: 10, seed: false });
    const { job, chat, task } = requests();
    for (const req of [job, chat, task]) await engine.run({ ...req, account: { kind: "pinned", account: "slot 1" } });
    const runs = await engine.runs();
    const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect(byId.brief).toMatchObject({ jobId: "job-start-of-day", agentId: "start-of-day", loud: true, title: "Start of day", account: { kind: "pinned", account: "slot 1" } });
    expect(byId.chat).toMatchObject({ agentId: "start-of-day", title: "hello" });
    expect(byId.chat?.jobId).toBeUndefined();
    expect(byId.task?.agentId).toBeUndefined();

    expect(runs.filter(isAgentRun).map((r) => r.id)).toEqual(["brief"]);
    expect(runs.filter(isChatTurn).map((r) => r.id)).toEqual(["chat"]);
    // Developer › Runs lists tasks and agents' runs, not chat turns.
    expect(taskRuns(runs).map((r) => r.id).sort()).toEqual(["brief", "task"]);
  });

  it("lists one job's runs, newest first, up to a limit (run.list by job)", async () => {
    let clock = 1_000;
    const engine = new FakeEngine({ stepMs: 10, seed: false, now: () => clock });
    const { job, task } = requests();
    for (const id of ["first", "second", "third"]) {
      clock += 1_000;
      await engine.run({ ...job, id });
    }
    await engine.run(task);
    expect((await engine.runs({ jobId: "job-start-of-day" })).map((r) => r.id)).toEqual(["third", "second", "first"]);
    expect((await engine.runs({ jobId: "job-start-of-day", limit: 1 })).map((r) => r.id)).toEqual(["third"]);
    expect(await engine.runs({ jobId: "job-nobody" })).toEqual([]);
  });

  it("seeds the GTM agent's run with its job and agent, titled by its name", async () => {
    const engine = new FakeEngine({ stepMs: 10_000 });
    const gtm = (await engine.runs()).find((r) => r.agentId === "gtm-agent");
    expect(gtm).toMatchObject({ jobId: "job-gtm-agent", title: "GTM agent", loud: false });
  });
});

describe("Engine.install (F1)", () => {
  it("installs Claude Code with progress, from not installed to signed out", async () => {
    const engine = new FakeEngine({ stepMs: 4, seed: false });
    engine.setClaudeState("not-installed");
    expect((await engine.status()).kind).toBe("not-installed");
    const progress: number[] = [];
    await engine.install((pct) => progress.push(pct));
    expect(progress).toEqual([20, 40, 60, 80, 100]);
    expect((await engine.status()).kind).toBe("signed-out");
  });
});
