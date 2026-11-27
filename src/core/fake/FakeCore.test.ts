import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEngine } from "../../engine/fake/FakeEngine.ts";
import { BRIEFING_SCHEMA } from "../../engine/runs.ts";
import { seedAgents, type Agent } from "../../state/agents.ts";
import { DEFAULT_WIDGETS, DEVICE_SETTING_KEYS, type Settings } from "../../state/model.ts";
import { GMAIL, SLACK } from "../connectors.ts";
import { DEVICE_STORAGE_KEY, DeviceStore, LEGACY_SETTINGS_KEY, migrateLegacySettings, type DeviceStorage } from "../device.ts";
import { HOLD_MS } from "../gate.ts";
import { MemoryHostStore, type HostStore } from "../host.ts";
import { APPROVE_CHOICE, DISCARD_CHOICE, pendingUnread, type PendingItem } from "../pending.ts";
import { FakeCore } from "./FakeCore.ts";
import { FAKE_HOST_STORAGE_KEY, LocalHostStore } from "./hostStore.ts";

class MemoryStorage implements DeviceStorage {
  readonly items = new Map<string, string>();
  /** Writes throw, as a full or locked-down storage does. */
  failWrites = false;
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
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

interface MakeOptions {
  seedRuns?: boolean;
  engine?: FakeEngine;
  storage?: MemoryStorage;
  device?: DeviceStore;
  host?: HostStore;
  settings?: Partial<Settings>;
  agents?: Agent[];
  pending?: PendingItem[];
  now?: () => number;
}

function make({ seedRuns = false, engine = new FakeEngine({ stepMs: 5, seed: seedRuns }), storage = new MemoryStorage(), device, host = new MemoryHostStore(), ...rest }: MakeOptions = {}) {
  const deviceStore = device ?? new DeviceStore(storage);
  const core = new FakeCore({ engine, device: deviceStore, host, ...rest });
  cores.push(core);
  return { engine, storage, device: deviceStore, host, core };
}

const draftFor = (destination: string) => ({ origin: "widget" as const, connector: GMAIL, destination, body: "Hi", context: "" });

describe("FakeCore storage: the host's settings and this device's", () => {
  it("keeps only device-local settings in this device's storage, whatever else changes", async () => {
    const { core, storage, host } = make();
    await core.updateSettings({ mode: "light", agentName: "Atlas", onboarded: true });
    await core.setSendMode(SLACK, "preapproved");
    await core.updateSettings({ devMode: true, engineHome: "/tmp/rlx-sandbox-test" });
    await core.addWidget({ id: "w-extra", type: "clock" });
    await core.createDraft(draftFor("Lena"));
    await core.approveAndSend("d-seed-1");

    expect([...storage.items.keys()]).toEqual([DEVICE_STORAGE_KEY]);
    const stored = JSON.parse(storage.getItem(DEVICE_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([...DEVICE_SETTING_KEYS].sort());
    expect(stored).toEqual({ onboarded: true, devMode: true, engineHome: "/tmp/rlx-sandbox-test" });
    // The host has the rest.
    expect(host.load()?.settings).toMatchObject({ mode: "light", agentName: "Atlas", sendModes: { [SLACK]: "preapproved" } });
    expect(host.load()?.settings).not.toHaveProperty("devMode");
  });

  it("survives a relaunch: the host keeps settings, agents and widgets; the device keeps its own", async () => {
    const storage = new MemoryStorage();
    const host = new MemoryHostStore();
    const first = make({ storage, host });
    await first.core.updateSettings({ agentName: "Atlas", ownerName: "Ada Park", mode: "light", onboarded: true });
    await first.core.setSendMode(GMAIL, "preapproved");
    await first.core.addWidget({ id: "w-clock-2", type: "clock" });
    await first.core.sendMessage("manager", "Every weekday at 9 give me a start of day briefing");
    const proposal = first.core.snapshot().messages.find((m) => m.card?.type === "proposal");
    if (proposal?.card?.type !== "proposal") throw new Error("no proposal");
    await first.core.confirmProposal(proposal.id, proposal.card.proposal);
    first.core.dispose();

    const { core } = make({ storage, host });
    expect(core.snapshot().settings).toMatchObject({ agentName: "Atlas", ownerName: "Ada Park", mode: "light", onboarded: true, sendModes: { [GMAIL]: "preapproved" } });
    expect(core.snapshot().settings.widgets.map((w) => w.id)).toContain("w-clock-2");
    expect(core.snapshot().agents.map((a) => a.id)).toContain("start-of-day");
    expect(core.snapshot().activity[0]?.signOff).toBe("— Atlas, Ada Park's AI Agent");
  });

  it("persists the preview's fake host in the browser's storage, under its own key", async () => {
    const storage = new MemoryStorage();
    const { core } = make({ storage, host: new LocalHostStore(storage) });
    await core.updateSettings({ agentName: "Atlas" });
    expect(JSON.parse(storage.getItem(FAKE_HOST_STORAGE_KEY) ?? "{}")).toMatchObject({ settings: { agentName: "Atlas" }, agents: expect.any(Array) });
    expect(new LocalHostStore(storage).load()?.settings.agentName).toBe("Atlas");
  });

  /** What rc's shell stored: every setting, agents included, with connectors as people name them. */
  function rcSettings(): string {
    const rcAgent = (id: string, name: string, connectors: string[], patch: Record<string, unknown> = {}) => ({
      id,
      name,
      avatar: name[0],
      purpose: `${name} things`,
      connectors,
      schedule: { kind: "daily", at: "08:45" },
      mode: "silent",
      outputs: ["dashboard"],
      state: "asleep",
      ...patch,
    });
    return JSON.stringify({
      onboarded: true,
      devMode: true,
      engineHome: "~/.rlx-sandbox-2",
      agentName: "Kai",
      ownerName: "Ana Li",
      family: "rlx",
      mode: "light",
      sendModes: { "claude.ai Slack": "preapproved", "claude.ai Gmail": "draft", "claude.ai Linear": "draft" },
      widgets: [{ id: "w-slack", type: "slack" }, { id: "w-linear", type: "generic", connector: "claude.ai Linear" }],
      agents: [
        rcAgent("meetings-agent", "Meetings agent", ["Google Calendar", "Meet transcripts (Google Drive)"], { state: "paused" }),
        rcAgent("start-of-day", "Start of day", ["Google Calendar", "Meet transcripts (Google Drive)", "Gmail", "Slack"], {
          role: "briefing",
          schedule: { kind: "weekdays", at: "09:00" },
          mode: "loud",
          outputs: ["channel", "dashboard"],
        }),
      ],
    });
  }

  it("migrates rc's settings once: device keys to the device, the rest to the host, then removes the old key", async () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_SETTINGS_KEY, rcSettings());
    const host = new MemoryHostStore();
    const device = new DeviceStore(storage);
    expect(migrateLegacySettings(storage, device, host)).toBe(true);
    expect(storage.getItem(LEGACY_SETTINGS_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(DEVICE_STORAGE_KEY) ?? "{}")).toEqual({ onboarded: true, devMode: true, engineHome: "~/.rlx-sandbox-2" });
    expect(host.load()?.settings).not.toHaveProperty("devMode");

    const { core } = make({ storage, device, host });
    expect(core.snapshot().settings).toMatchObject({ onboarded: true, devMode: true, agentName: "Kai", ownerName: "Ana Li", mode: "light", sendModes: { [SLACK]: "preapproved" } });
    expect(core.snapshot().settings.widgets).toEqual([
      { id: "w-slack", type: "slack", agentId: undefined },
      { id: "w-linear", type: "generic", connector: "claude.ai Linear", agentId: undefined },
    ]);
    const [meetings, startOfDay] = core.snapshot().agents;
    expect(meetings).toMatchObject({ id: "meetings-agent", jobId: "job-meetings-agent", state: "paused", connectors: ["claude.ai Google Calendar", "claude.ai Google Drive"] });
    expect(startOfDay).toMatchObject({ id: "start-of-day", jobId: "job-start-of-day", role: "briefing", connectors: ["claude.ai Google Calendar", "claude.ai Google Drive", GMAIL, SLACK] });

    // Once: what changed since stays, and the old key is gone, so nothing migrates again.
    await core.updateSettings({ agentName: "New" });
    core.dispose();
    const again = new DeviceStore(storage);
    expect(migrateLegacySettings(storage, again, host)).toBe(false);
    expect(make({ storage, device: again, host }).core.snapshot().settings.agentName).toBe("New");
  });

  it("keeps rc's settings until the writes land: a failed write leaves the old key for the next launch", () => {
    const storage = new MemoryStorage();
    const legacy = rcSettings();
    storage.setItem(LEGACY_SETTINGS_KEY, legacy);
    storage.failWrites = true;
    expect(migrateLegacySettings(storage, new DeviceStore(storage), new LocalHostStore(storage))).toBe(false);
    expect(storage.getItem(LEGACY_SETTINGS_KEY)).toBe(legacy);

    storage.failWrites = false;
    const host = new LocalHostStore(storage);
    expect(migrateLegacySettings(storage, new DeviceStore(storage), host)).toBe(true);
    expect(storage.getItem(LEGACY_SETTINGS_KEY)).toBeNull();
    expect(host.load()?.settings.agentName).toBe("Kai");
  });

  it("shares one DeviceStore between cores: a device setting changed in one shows in the other", async () => {
    const device = new DeviceStore(new MemoryStorage());
    const a = make({ device });
    const b = make({ device });
    await a.core.updateSettings({ devMode: true });
    expect(b.core.snapshot().settings.devMode).toBe(true);
  });

  it("changes send modes only through setSendMode", async () => {
    const { core } = make();
    await core.updateSettings({ sendModes: { [SLACK]: "auto" } } as Partial<Settings>);
    expect(core.snapshot().settings.sendModes[SLACK]).toBe("draft");
    await expect(core.setSendMode(SLACK, "auto")).resolves.toBe(true);
    expect(core.snapshot().settings.sendModes[SLACK]).toBe("auto");
  });
});

describe("FakeCore send gate", () => {
  it("refuses an unapproved draft in Draft mode, and sends it as the owner once approved", async () => {
    const { core } = make();
    await expect(core.send("d-seed-1")).resolves.toBe("refused");
    expect(core.snapshot().drafts.map((d) => d.id)).toContain("d-seed-1");
    await core.approveDraft("d-seed-1");
    await expect(core.send("d-seed-1")).resolves.toBe("sent");
    expect(core.snapshot().activity[0]).toMatchObject({ id: "act-d-seed-1", approvedBy: "owner", signOff: "— Nova, Sam Rivera's AI Agent" });
  });

  it("sends under a covering standing approval on Pre-approved", async () => {
    const { core } = make({ settings: { sendModes: { [SLACK]: "preapproved" } } });
    const id = await core.createDraft({ origin: "widget", connector: SLACK, destination: "#dev", body: "CI is green. Deploy?", context: "" });
    await expect(core.send(id)).resolves.toBe("sent");
    expect(core.snapshot().activity[0]).toMatchObject({ destination: "#dev", approvedBy: "standing approval" });
    const uncovered = await core.createDraft({ origin: "widget", connector: SLACK, destination: "#random", body: "Hi", context: "" });
    await expect(core.send(uncovered)).resolves.toBe("refused");
  });

  it("holds an Auto send for 10 seconds, with Undo", async () => {
    vi.useFakeTimers();
    const { core } = make({ settings: { sendModes: { [SLACK]: "auto" } } });
    await expect(core.send("d-seed-1")).resolves.toBe("held");
    expect(core.snapshot().drafts[0]?.status).toBe("held");
    await core.undoSend("d-seed-1");
    expect(core.snapshot().drafts[0]?.status).toBe("pending");
    vi.advanceTimersByTime(HOLD_MS);
    expect(core.snapshot().activity.some((a) => a.id === "act-d-seed-1")).toBe(false);
    await expect(core.send("d-seed-1")).resolves.toBe("held");
    vi.advanceTimersByTime(HOLD_MS);
    expect(core.snapshot().activity[0]).toMatchObject({ id: "act-d-seed-1", approvedBy: "auto" });
    expect(core.snapshot().drafts).toEqual([]);
  });
});

describe("FakeCore widget data jobs", () => {
  const slack = DEFAULT_WIDGETS.find((w) => w.type === "slack")!;

  it("runs a watched widget's refresh with its account and agent, and records the agent's outcome", async () => {
    const { core, engine } = make();
    const pinned = { ...slack, account: { kind: "pinned" as const, account: "slot 1" } };
    const off = core.watchWidget(pinned);
    const run = (await engine.runs()).find((r) => r.kind === "widget_refresh");
    expect(run).toMatchObject({ agentId: "slack-agent", account: { kind: "pinned", account: "slot 1" } });
    await vi.waitFor(() => expect(core.snapshot().widgetData[slack.id]).toMatchObject({ status: "ok", data: expect.objectContaining({ reviewed: 3 }) }));
    expect(core.snapshot().agents.find((a) => a.id === "slack-agent")?.lastRun).toMatchObject({ outcome: "Claude reviewed 3 new", modelTurn: true, runId: run?.id });
    off();
  });

  it("uses Auto when a widget pins no account, and refreshes on demand", async () => {
    const { core, engine } = make();
    const gmail = DEFAULT_WIDGETS.find((w) => w.type === "gmail")!;
    const off = core.watchWidget(gmail);
    await vi.waitFor(() => expect(core.snapshot().widgetData[gmail.id]?.status).toBe("ok"));
    await core.refreshWidget(gmail.id);
    expect(core.snapshot().widgetData[gmail.id]?.status).toBe("refreshing");
    await vi.waitFor(() => expect(core.snapshot().widgetData[gmail.id]?.status).toBe("ok"));
    const refreshes = (await engine.runs()).filter((r) => r.kind === "widget_refresh");
    expect(refreshes).toHaveLength(2);
    expect(refreshes.every((r) => r.account?.kind === "auto")).toBe(true);
    off();
  });

  it("keeps the last good data through a refresh, and stops the job when the last watcher leaves, cancelling a refresh in flight", async () => {
    const { core, engine } = make();
    const first = core.watchWidget(slack);
    await vi.waitFor(() => expect(core.snapshot().widgetData[slack.id]?.status).toBe("ok"));
    const second = core.watchWidget(slack);
    await core.refreshWidget(slack.id);
    expect(core.snapshot().widgetData[slack.id]).toMatchObject({ status: "refreshing", data: expect.objectContaining({ reviewed: 3 }) });
    first();
    expect(core.snapshot().widgetData[slack.id]).toBeDefined();
    second();
    await vi.waitFor(async () => expect((await engine.runs()).filter((r) => r.kind === "widget_refresh").map((r) => r.state)).toContain("failed"));
    expect(core.snapshot().widgetData[slack.id]).toBeUndefined();
  });

  it("restarts a watched job when a setting changes it (the Slack interval)", async () => {
    const { core, engine } = make();
    const off = core.watchWidget(slack);
    await vi.waitFor(() => expect(core.snapshot().widgetData[slack.id]?.status).toBe("ok"));
    await core.updateSettings({ slackIntervalMin: 30 });
    await vi.waitFor(async () => expect((await engine.runs()).filter((r) => r.kind === "widget_refresh")).toHaveLength(2));
    off();
  });

  it("links an added widget to the agent that outputs to a widget from its connector", async () => {
    const { core } = make();
    await core.addWidget({ id: "w-slack-2", type: "slack" });
    await core.addWidget({ id: "w-clock-2", type: "clock" });
    const widgets = core.snapshot().settings.widgets;
    expect(widgets.find((w) => w.id === "w-slack-2")?.agentId).toBe("slack-agent");
    expect(widgets.find((w) => w.id === "w-clock-2")?.agentId).toBeUndefined();
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
    await core.editAgent("gmail-agent", { ...gmail!, name: "Inbox watcher" });
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

  it("ends a reply that never started instead of leaving it streaming", async () => {
    const engine = new FakeEngine({ stepMs: 5, seed: false });
    vi.spyOn(engine, "run").mockRejectedValue(new Error("rlxd unreachable"));
    const { core } = make({ engine });
    await core.sendMessage("slack-agent", "Hello?");
    expect(core.snapshot().messages.at(-1)).toMatchObject({ from: "agent", streaming: false, text: "Sorry, that didn't go through. Try again." });
  });

  it("turns a confirmed proposal into an agent with its own job, scheduled and asleep", async () => {
    const { core } = make();
    await core.sendMessage("manager", "Every weekday at 9 give me a start of day briefing");
    const message = core.snapshot().messages.find((m) => m.card?.type === "proposal");
    if (message?.card?.type !== "proposal") throw new Error("no proposal card");
    const agent = await core.confirmProposal(message.id, message.card.proposal);
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

describe("FakeCore delivers what ran while the app was closed (F-d)", () => {
  const briefingAgent = (): Agent => ({
    id: "start-of-day",
    jobId: "job-start-of-day",
    name: "Start of day",
    avatar: "SD",
    purpose: "Gathers outcomes.",
    role: "briefing",
    connectors: [SLACK, GMAIL],
    schedule: { kind: "weekdays", at: "09:00" },
    mode: "loud",
    outputs: ["channel", "dashboard"],
    state: "asleep",
  });

  /** The 9:00 briefing ran (twice, say) before any app was open. */
  async function ranWhileClosed(engine: FakeEngine): Promise<string> {
    const run = (id: string) =>
      engine.run({ id, kind: "task", prompt: "Start of day", jobId: "job-start-of-day", agentId: "start-of-day", loud: true, outputSchema: BRIEFING_SCHEMA, mount: { kind: "no_tools" }, needsConnectors: [], persist: true });
    await run("older");
    // A later start, so it's the newer run.
    await new Promise((r) => setTimeout(r, 5));
    await run("latest");
    await vi.waitFor(async () => expect((await engine.runs()).filter((r) => r.state === "done")).toHaveLength(2));
    return "latest";
  }

  it("delivers each job's latest outcome once on start, without a second notification", async () => {
    const engine = new FakeEngine({ stepMs: 5, seed: false });
    const latest = await ranWhileClosed(engine);
    const host = new MemoryHostStore();
    const { core } = make({ engine, host, agents: [briefingAgent()] });
    await vi.waitFor(() => expect(core.snapshot().briefing).not.toBeNull());
    expect(core.snapshot().messages.filter((m) => m.text?.startsWith("Good morning"))).toHaveLength(1);
    expect(core.snapshot().notices).toEqual([]);
    expect(core.snapshot().agents[0]?.lastRun?.runId).toBe(latest);
    core.dispose();

    // A relaunch onto the same host: already delivered, so nothing again.
    const again = make({ engine, host });
    await new Promise((r) => setTimeout(r, 20));
    expect(again.core.snapshot().messages.filter((m) => m.text?.startsWith("Good morning"))).toHaveLength(0);
  });
});

describe("FakeCore Pending on you", () => {
  it("lists a run's question, and answering it resumes the run and leaves Open", async () => {
    const { core, engine } = make({ seedRuns: true });
    await vi.waitFor(() => expect(core.snapshot().pending.some((i) => i.kind === "question")).toBe(true));
    const question = core.snapshot().pending.find((i) => i.kind === "question")!;
    expect(question).toMatchObject({ status: "open", title: "Triage my inbox and draft replies", ownerOnly: false });
    expect(question.text).toMatch(/clause 7/);
    await core.answerPending(question.id, { kind: "text", text: "Ask for a 30-day notice period" });
    expect(core.snapshot().pending.find((i) => i.id === question.id)).toMatchObject({ status: "answered", answer: "Ask for a 30-day notice period", answeredBy: "person" });
    const run = (await engine.runs()).find((r) => r.id === question.runId);
    expect(run?.state).not.toBe("needs-you");
  });

  it("dismisses a question whose run was cancelled", async () => {
    const { core, engine } = make({ seedRuns: true });
    await vi.waitFor(() => expect(core.snapshot().pending.some((i) => i.kind === "question")).toBe(true));
    const question = core.snapshot().pending.find((i) => i.kind === "question")!;
    await engine.cancel(question.runId!);
    await vi.waitFor(() => expect(core.snapshot().pending.find((i) => i.id === question.id)?.status).toBe("dismissed"));
  });

  it("decides an approval only by an explicit choice: free text on an owner-only approval doesn't send", async () => {
    const { core } = make();
    const item = core.snapshot().pending.find((i) => i.draftId === "d-seed-1")!;
    expect(item).toMatchObject({ kind: "approval", ownerOnly: true, status: "open" });
    for (const text of ["wait, not yet", APPROVE_CHOICE, "yes send it"]) {
      await core.answerPending(item.id, { kind: "text", text });
    }
    expect(core.snapshot().drafts.map((d) => d.id)).toContain("d-seed-1");
    expect(core.snapshot().activity.some((a) => a.id === "act-d-seed-1")).toBe(false);
    expect(core.snapshot().pending.find((i) => i.id === item.id)).toMatchObject({ status: "open", note: "yes send it" });
    // A choice that isn't one of its answers does nothing either.
    await core.answerPending(item.id, { kind: "choice", label: "Send it later" });
    expect(core.snapshot().drafts.map((d) => d.id)).toContain("d-seed-1");

    await core.answerPending(item.id, { kind: "choice", label: APPROVE_CHOICE });
    expect(core.snapshot().activity[0]).toMatchObject({ id: "act-d-seed-1", approvedBy: "owner" });
    expect(core.snapshot().pending.find((i) => i.id === item.id)?.status).toBe("answered");

    const other = await core.createDraft(draftFor("Lena"));
    const otherItem = core.snapshot().pending.find((i) => i.draftId === other)!;
    await core.answerPending(otherItem.id, { kind: "choice", label: DISCARD_CHOICE });
    expect(core.snapshot().drafts.some((d) => d.id === other)).toBe(false);
    expect(core.snapshot().pending.find((i) => i.id === otherItem.id)?.status).toBe("dismissed");
  });

  it("lets the owner confirm or change what the manager assumed; owner-only items stay open", async () => {
    let clock = 1_000;
    const item = (id: string, patch: Partial<PendingItem> = {}): PendingItem => ({
      id,
      seq: 0,
      asker: "coder",
      kind: "question",
      title: "Theme",
      text: "Dark or light?",
      suggested: [{ label: "Dark" }, { label: "Light" }],
      ownerOnly: false,
      createdAt: 0,
      assumeAfter: 2_000,
      status: "open",
      ...patch,
    });
    const { core } = make({ now: () => clock, pending: [item("a"), item("b"), item("merge", { ownerOnly: true, text: "Merge to main?" })] });
    clock = 5_000;
    core.assumeDue();
    const byId = (id: string) => core.snapshot().pending.find((i) => i.id === id);
    expect(byId("a")).toMatchObject({ status: "assumed", answer: "Dark", answeredBy: "manager-assumed" });
    expect(byId("merge")?.status).toBe("open");

    await core.answerPending("a", { kind: "choice", label: "Light" });
    expect(byId("a")).toMatchObject({ status: "answered", answer: "Light", answeredBy: "person", changed: true });
    await core.confirmAssumed("b");
    expect(byId("b")).toMatchObject({ status: "answered", answer: "Dark", answeredBy: "manager-assumed", confirmed: true });
  });

  it("holds every draft as an owner-only approval item, closed when it's sent or discarded", async () => {
    const { core } = make();
    const seeded = core.snapshot().pending.find((i) => i.draftId === "d-seed-1");
    expect(seeded).toMatchObject({ kind: "approval", status: "open", ownerOnly: true });
    const id = await core.createDraft(draftFor("Lena"));
    const added = core.snapshot().pending.find((i) => i.draftId === id);
    expect(added?.seq).toBeGreaterThan(seeded?.seq ?? 0);
    await core.approveAndSend("d-seed-1");
    await core.discardDraft(id);
    expect(core.snapshot().pending.find((i) => i.draftId === "d-seed-1")?.status).toBe("answered");
    expect(core.snapshot().pending.find((i) => i.draftId === id)?.status).toBe("dismissed");
  });

  it("drives the unread dot from one last-seen marker: seen, open, mute and the off switch", async () => {
    const { core } = make();
    const unread = () => pendingUnread(core.snapshot().pending, core.snapshot().pendingMarker);
    const draft = () => core.createDraft(draftFor("Lena"));
    expect(unread()).toBe(true);
    await core.markPendingSeen();
    expect(unread()).toBe(false);
    await draft();
    expect(unread()).toBe(true);
    // Opening the section clears it, and items added while it's open never light it.
    core.view({ kind: "pending" });
    expect(unread()).toBe(false);
    await draft();
    expect(unread()).toBe(false);
    core.view(null);
    await core.setPendingMuted(true);
    await draft();
    expect(unread()).toBe(false);
    await core.setPendingMuted(false);
    expect(unread()).toBe(true);
    await core.setPendingEnabled(false);
    expect(unread()).toBe(false);
  });
});
