import { describe, expect, it } from "vitest";
import { AGENT_PREFIX, BRIEFING_ROLE, CHAT_PREFIX } from "../runs.ts";
import type { RunEvent } from "../types.ts";
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

describe("FakeEngine scheduling", () => {
  it("never lets the task scheduler finish an agent run or a chat turn (a race seen on slow CI)", async () => {
    const engine = new FakeEngine({ stepMs: 10, seed: false });
    const mount = { kind: "no_tools" } as const;
    const briefing = await engine.run({
      id: "brief",
      kind: "task",
      prompt: `${AGENT_PREFIX}start-of-day Start of day\n${BRIEFING_ROLE}\nGathers outcomes.`,
      mount,
      needsConnectors: [],
      persist: true,
    });
    const chat = await engine.run({ id: "chat", kind: "task", prompt: `${CHAT_PREFIX}hello`, mount, needsConnectors: [], persist: true });
    // A plain task schedules immediately, while the two above are still queued on their timers.
    await engine.run({ id: "task", kind: "task", prompt: "Draft the launch email", mount, needsConnectors: [], persist: true });
    const [b, c] = await Promise.all([finished(engine, briefing), finished(engine, chat)]);
    expect(b.status).toBe("done");
    expect(b.output).toMatchObject({ doNow: expect.any(Array), today: expect.any(Array) });
    expect(c.output).toMatchObject({ reply: expect.any(String) });
  });
});
