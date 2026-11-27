import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEngine } from "../../engine/fake/FakeEngine.ts";
import { seedAgents, type Agent } from "../../state/agents.ts";
import { DEVICE_SETTING_KEYS } from "../../state/model.ts";
import { GMAIL, SLACK } from "../connectors.ts";
import { DEVICE_STORAGE_KEY, LEGACY_SETTINGS_KEY, type DeviceStorage } from "../device.ts";
import { HOLD_MS } from "../gate.ts";
import { pendingUnread } from "../pending.ts";
import { FakeCore, type FakeCoreOptions } from "./FakeCore.ts";

class MemoryStorage implements DeviceStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const cores: FakeCore[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.dispose();
  vi.useRealTimers();
});

function make(options: Partial<FakeCoreOptions> & { seedRuns?: boolean } = {}) {
  const { seedRuns = false, ...rest } = options;
  const engine = new FakeEngine({ stepMs: 5, seed: seedRuns });
  const storage = new MemoryStorage();
  const core = new FakeCore({ engine, storage, ...rest });
  cores.push(core);
  return { engine, storage, core };
}

describe("FakeCore storage: the host's settings and this device's", () => {
  it("keeps only device-local settings in this device's storage, whatever else changes", () => {
    const { core, storage } = make();
    core.updateSettings({ mode: "light", agentName: "Atlas", sendModes: { [SLACK]: "auto" }, onboarded: true });
    core.updateSettings({ devMode: true, engineHome: "/tmp/rlx-sandbox-test" });
    core.addWidget({ id: "w-extra", type: "clock" });
    core.createDraft({ origin: "widget", connector: GMAIL, destination: "Lena", body: "Hi", context: "test" });
    core.approveAndSend("d-seed-1");

    expect([...storage.items.keys()]).toEqual([DEVICE_STORAGE_KEY]);
    const stored = JSON.parse(storage.getItem(DEVICE_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([...DEVICE_SETTING_KEYS].sort());
    expect(stored).toEqual({ onboarded: true, devMode: true, engineHome: "/tmp/rlx-sandbox-test" });
    // The core still has every change; they're the host's.
    expect(core.snapshot().settings).toMatchObject({ mode: "light", agentName: "Atlas", sendModes: { [SLACK]: "auto" } });
  });

  it("shares host settings with the host, not with the next window on this device", () => {
    const { core, storage, engine } = make();
    core.updateSettings({ agentName: "Atlas", mode: "light", devMode: true });
    const next = new FakeCore({ engine, storage });
    cores.push(next);
    // A fresh core on the same device: its device settings carry over, the fake host's don't.
    expect(next.snapshot().settings).toMatchObject({ devMode: true, agentName: "Nova", mode: "dark" });
  });

  it("drops the pre-seam all-settings key, and never reads product state from it", () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({ agentName: "Old", onboarded: true, devMode: true, agents: [] }));
    storage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ engineHome: "/tmp/x", agentName: "Sneaky" }));
    const core = new FakeCore({ engine: new FakeEngine({ seed: false }), storage });
    cores.push(core);
    expect(storage.getItem(LEGACY_SETTINGS_KEY)).toBeNull();
    expect(core.snapshot().settings).toMatchObject({ engineHome: "/tmp/x", agentName: "Nova", onboarded: false, devMode: false });
  });

  it("seeds the fake host from the given settings (tests, the preview's browser checks)", () => {
    const { core, storage } = make({ settings: { onboarded: true, family: "solarized", devMode: true } });
    expect(core.snapshot().settings).toMatchObject({ onboarded: true, family: "solarized", devMode: true });
    expect(storage.items.size).toBe(0);
  });
});

describe("FakeCore send gate", () => {
  it("refuses an unapproved draft in Draft mode, and sends it as the owner once approved", () => {
    const { core } = make();
    expect(core.send("d-seed-1")).toBe("refused");
    expect(core.snapshot().drafts.map((d) => d.id)).toContain("d-seed-1");
    core.approveDraft("d-seed-1");
    expect(core.send("d-seed-1")).toBe("sent");
    const sent = core.snapshot().activity[0];
    expect(sent).toMatchObject({ id: "act-d-seed-1", approvedBy: "owner", signOff: "— Nova, Sam Rivera's AI Agent" });
  });

  it("sends under a covering standing approval on Pre-approved", () => {
    const { core } = make({ settings: { sendModes: { [SLACK]: "preapproved" } } });
    const id = core.createDraft({ origin: "widget", connector: SLACK, destination: "#dev", body: "CI is green. Deploy?", context: "" });
    expect(core.send(id)).toBe("sent");
    expect(core.snapshot().activity[0]).toMatchObject({ destination: "#dev", approvedBy: "standing approval" });
    const uncovered = core.createDraft({ origin: "widget", connector: SLACK, destination: "#random", body: "Hi", context: "" });
    expect(core.send(uncovered)).toBe("refused");
  });

  it("holds an Auto send for 10 seconds, with Undo", () => {
    vi.useFakeTimers();
    const { core } = make({ settings: { sendModes: { [SLACK]: "auto" } } });
    expect(core.send("d-seed-1")).toBe("held");
    expect(core.snapshot().drafts[0]?.status).toBe("held");
    core.undoSend("d-seed-1");
    expect(core.snapshot().drafts[0]?.status).toBe("pending");
    vi.advanceTimersByTime(HOLD_MS);
    expect(core.snapshot().activity.some((a) => a.id === "act-d-seed-1")).toBe(false);
    expect(core.send("d-seed-1")).toBe("held");
    vi.advanceTimersByTime(HOLD_MS);
    expect(core.snapshot().activity[0]).toMatchObject({ id: "act-d-seed-1", approvedBy: "auto" });
    expect(core.snapshot().drafts).toEqual([]);
  });
});

describe("FakeCore agents (the scheduler's follow-up)", () => {
  it("wakes an agent's job with its job, agent, loud flag and account, and records the outcome when it ends", async () => {
    const agents: Agent[] = seedAgents(Date.now()).map((a) => (a.id === "slack-agent" ? { ...a, account: { kind: "pinned", account: "slot 1" } } : a));
    const { core, engine } = make({ agents });
    await core.wake("slack-agent");
    const run = (await engine.runs()).find((r) => r.agentId === "slack-agent");
    expect(run).toMatchObject({ jobId: "job-slack-agent", agentId: "slack-agent", loud: false, account: { kind: "pinned", account: "slot 1" } });
    await vi.waitFor(() => expect(core.snapshot().runningAgents).toEqual([]));
    await vi.waitFor(() => expect(core.snapshot().agents.find((a) => a.id === "slack-agent")?.lastRun?.outcome).toBe("Claude reviewed 3 new"));
    // The run's outcome lands in the agent's channel, unread while the channel isn't open.
    expect(core.snapshot().messages.at(-1)).toMatchObject({ channel: "slack-agent", from: "system", text: "Woke · Claude reviewed 3 new · asleep again" });
  });

  it("runs Auto when an agent pins no account", async () => {
    const { core, engine } = make();
    await core.wake("gmail-agent");
    expect((await engine.runs()).find((r) => r.agentId === "gmail-agent")?.account).toEqual({ kind: "auto" });
  });

  it("follows runs by agent id, so renaming an agent never loses its outcome", async () => {
    const { core } = make();
    const gmail = core.snapshot().agents.find((a) => a.id === "gmail-agent");
    core.editAgent("gmail-agent", { ...gmail!, name: "Inbox watcher" });
    await core.wake("gmail-agent");
    await vi.waitFor(() => expect(core.snapshot().messages.some((m) => m.channel === "gmail-agent" && m.from === "system")).toBe(true));
    expect(core.snapshot().agents.find((a) => a.id === "gmail-agent")).toMatchObject({ name: "Inbox watcher", avatar: "I" });
  });

  it("counts an agent's replies unread only while its channel isn't on screen", async () => {
    const { core } = make();
    await core.sendMessage("slack-agent", "What needs me today?");
    expect(core.snapshot().unread["slack-agent"]).toBe(1);
    const reply = core.snapshot().messages.at(-1);
    expect(reply).toMatchObject({ channel: "slack-agent", from: "agent", streaming: false });
    expect(reply?.text).toBeTruthy();
    core.view({ kind: "channel", id: "slack-agent" });
    expect(core.snapshot().unread["slack-agent"]).toBe(0);
    await core.sendMessage("slack-agent", "Thanks");
    expect(core.snapshot().unread["slack-agent"]).toBe(0);
  });

  it("turns a confirmed proposal into an agent with its own job, scheduled and asleep", async () => {
    const { core } = make();
    await core.sendMessage("manager", "Every weekday at 9 give me a start of day briefing");
    const message = core.snapshot().messages.find((m) => m.card?.type === "proposal");
    if (message?.card?.type !== "proposal") throw new Error("no proposal card");
    const agent = core.confirmProposal(message.id, message.card.proposal);
    expect(agent).toMatchObject({ id: "start-of-day", jobId: "job-start-of-day", role: "briefing", state: "asleep", mode: "loud" });
    expect(core.snapshot().messages.find((m) => m.id === message.id)?.card).toMatchObject({ status: "confirmed" });
    expect(core.snapshot().messages.at(-1)?.text).toMatch(/^Done\. Start of day is scheduled for weekdays at 09:00\./);
  });

  it("stops following the engine once disposed", async () => {
    const { core } = make();
    const before = core.snapshot();
    core.dispose();
    await core.wake("slack-agent");
    await new Promise((r) => setTimeout(r, 40));
    expect(core.snapshot()).toBe(before);
  });
});

describe("FakeCore Pending on you", () => {
  it("lists a run's question, and answering it resumes the run and leaves Open", async () => {
    const { core, engine } = make({ seedRuns: true });
    await vi.waitFor(() => expect(core.snapshot().pending.some((i) => i.kind === "question")).toBe(true));
    const question = core.snapshot().pending.find((i) => i.kind === "question")!;
    expect(question).toMatchObject({ status: "open", title: "Triage my inbox and draft replies", ownerOnly: false });
    expect(question.text).toMatch(/clause 7/);
    await core.answerPending(question.id, "Ask for a 30-day notice period");
    expect(core.snapshot().pending.find((i) => i.id === question.id)).toMatchObject({ status: "answered", answer: "Ask for a 30-day notice period", answeredBy: "person" });
    const run = (await engine.runs()).find((r) => r.id === question.runId);
    expect(run?.state).not.toBe("needs-you");
  });

  it("holds every draft as an owner-only approval item, closed when it's sent or discarded", () => {
    const { core } = make();
    const seeded = core.snapshot().pending.find((i) => i.draftId === "d-seed-1");
    expect(seeded).toMatchObject({ kind: "approval", status: "open", ownerOnly: true });
    const id = core.createDraft({ origin: "widget", connector: GMAIL, destination: "Lena", body: "Hi", context: "" });
    const added = core.snapshot().pending.find((i) => i.draftId === id);
    expect(added?.seq).toBeGreaterThan(seeded?.seq ?? 0);
    core.approveAndSend("d-seed-1");
    core.discardDraft(id);
    expect(core.snapshot().pending.find((i) => i.draftId === "d-seed-1")?.status).toBe("answered");
    expect(core.snapshot().pending.find((i) => i.draftId === id)?.status).toBe("dismissed");
  });

  it("drives the unread dot from one last-seen marker: seen, open, mute and the off switch", () => {
    const { core } = make();
    const unread = () => pendingUnread(core.snapshot().pending, core.snapshot().pendingMarker);
    const draft = () => core.createDraft({ origin: "widget", connector: GMAIL, destination: "Lena", body: "Hi", context: "" });
    expect(unread()).toBe(true);
    core.markPendingSeen();
    expect(unread()).toBe(false);
    draft();
    expect(unread()).toBe(true);
    // Opening the section clears it, and items added while it's open never light it.
    core.view({ kind: "pending" });
    expect(unread()).toBe(false);
    draft();
    expect(unread()).toBe(false);
    core.view(null);
    core.setPendingMuted(true);
    draft();
    expect(unread()).toBe(false);
    core.setPendingMuted(false);
    expect(unread()).toBe(true);
    core.setPendingEnabled(false);
    expect(unread()).toBe(false);
  });
});
