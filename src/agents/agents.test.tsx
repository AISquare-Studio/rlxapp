import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { FakeEngine, parseInstruction } from "../engine/fake/FakeEngine.ts";
import { browserPlatform } from "../platform/index.ts";
import { agentStatus, nextWake, seedAgents } from "../state/agents.ts";
import { DEFAULT_SETTINGS, type Settings } from "../state/model.ts";

const onboarded: Settings = { ...DEFAULT_SETTINGS, onboarded: true };

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

function renderApp(settings: Settings = onboarded) {
  const engine = new FakeEngine({ stepMs: 20 });
  render(<App platform={browserPlatform} engine={engine} initialSettings={settings} />);
  return engine;
}

/** Creates "Start of day" through the manager's DM, as the owner would. */
async function createStartOfDay() {
  fireEvent.click(await screen.findByRole("button", { name: "Manager, setup assistant" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message Manager" }), {
    target: { value: "Every weekday at 9 give me a start of day briefing" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Send/ }));
  const card = await screen.findByTestId("proposal-card");
  return card;
}

async function confirmStartOfDay() {
  const card = await createStartOfDay();
  fireEvent.click(within(card).getByRole("button", { name: "Confirm" }));
  await screen.findByText(/Start of day is scheduled/);
}

describe("schedules", () => {
  it("wakes weekday agents on the next weekday, and interval agents after their interval", () => {
    const friday = new Date(2026, 10, 27, 10, 0).getTime();
    const next = new Date(nextWake({ kind: "weekdays", at: "09:00" }, friday));
    expect([next.getDay(), next.getHours(), next.getMinutes()]).toEqual([1, 9, 0]);
    const early = new Date(2026, 10, 27, 8, 0).getTime();
    expect(new Date(nextWake({ kind: "weekdays", at: "09:00" }, early)).getDate()).toBe(27);
    expect(nextWake({ kind: "interval", everyMin: 15 }, friday) - friday).toBe(15 * 60_000);
  });

  it("calls an agent running only while the engine runs it, and paused, scheduled or asleep otherwise", () => {
    const now = Date.now();
    const [slack, , meetings] = seedAgents(now);
    expect(agentStatus(slack!, false, now).kind).toBe("asleep");
    expect(agentStatus(slack!, true, now).kind).toBe("running");
    expect(agentStatus(meetings!, false, now).label).toBe("Scheduled 08:45");
    expect(agentStatus({ ...meetings!, state: "paused" }, false, now).kind).toBe("paused");
  });

  it("proposes Start of day from the owner's words, with suggested connectors, never a fixed list", () => {
    const proposal = parseInstruction("every weekday at 9 give me a start of day briefing");
    expect(proposal).toMatchObject({ name: "Start of day", role: "briefing", mode: "loud", schedule: { kind: "weekdays", at: "09:00" } });
    expect(proposal.connectors).toEqual(["Google Calendar", "Meet transcripts (Google Drive)", "Gmail", "Slack"]);
    expect(parseInstruction("daily at 5pm, a briefing").schedule).toEqual({ kind: "daily", at: "17:00" });
  });
});

describe("Agents section", () => {
  it("lists running, scheduled and asleep agents with next wake, last run, connectors and Wake now / Pause / Edit", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    const gtm = await screen.findByTestId("agent-row-gtm-agent");
    expect(within(gtm).getByText("Running")).toBeTruthy();
    const meetings = screen.getByTestId("agent-row-meetings-agent");
    expect(within(meetings).getByText("Scheduled 08:45")).toBeTruthy();
    expect(within(meetings).getByText(/Daily at 08:45 · next wake/)).toBeTruthy();
    expect(within(meetings).getByText("Meet transcripts (Google Drive)")).toBeTruthy();
    const slack = screen.getByTestId("agent-row-slack-agent");
    expect(within(slack).getByText("Asleep")).toBeTruthy();
    expect(within(slack).getByText("Silent")).toBeTruthy();
    expect(within(slack).getByText(/Fetched, nothing new, no Claude usage/)).toBeTruthy();
    expect(within(slack).getByText("no Claude usage")).toBeTruthy();

    fireEvent.click(within(meetings).getByRole("button", { name: "Pause Meetings agent" }));
    expect(within(meetings).getByText("Paused")).toBeTruthy();
    expect((within(meetings).getByRole("button", { name: "Wake Meetings agent now" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(meetings).getByRole("button", { name: "Resume Meetings agent" }));
    expect(within(meetings).getByText("Scheduled 08:45")).toBeTruthy();

    fireEvent.click(within(slack).getByRole("button", { name: "Wake Slack agent now" }));
    expect(await within(slack).findByText("Running")).toBeTruthy();
    expect(await within(slack).findByText("Asleep")).toBeTruthy();

    fireEvent.click(within(slack).getByRole("button", { name: "Edit Slack agent" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Slack agent" });
    fireEvent.change(within(dialog).getByLabelText("Agent name"), { target: { value: "Slack watcher" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(screen.getByTestId("agent-row-slack-agent")).getByText("Slack watcher")).toBeTruthy();
  });
});

describe("Start of day", () => {
  it("is created by chatting with the manager: a proposal with editable connector chips, then confirm", async () => {
    renderApp();
    const card = await createStartOfDay();
    const chips = within(card).getByRole("list", { name: "Connectors" });
    expect(within(chips).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Google Calendar",
      "Meet transcripts (Google Drive)",
      "Gmail",
      "Slack",
    ]);
    fireEvent.click(within(card).getByRole("button", { name: "Remove Slack" }));
    fireEvent.change(within(card).getByLabelText("Add a connector"), { target: { value: "Slack" } });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(4);
    expect((within(card).getByLabelText("Schedule") as HTMLSelectElement).value).toBe("weekdays");
    expect((within(card).getByLabelText("Time") as HTMLInputElement).value).toBe("09:00");
    expect((within(card).getByLabelText("Loud: notify and post") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(card).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/Start of day is scheduled for weekdays at 09:00/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    const row = await screen.findByTestId("agent-row-start-of-day");
    expect(within(row).getByText("Scheduled 09:00")).toBeTruthy();
    expect(within(row).getByText(/Weekdays at 09:00 · next wake/)).toBeTruthy();
    expect(within(row).getByText("Loud")).toBeTruthy();
    expect(within(row).getByText("Hasn't run yet")).toBeTruthy();
  });

  it("Simulate 9:00 runs it loud: the prioritized dashboard with sources, a channel message and a notification", async () => {
    renderApp();
    await confirmStartOfDay();
    fireEvent.click(await screen.findByRole("button", { name: "Dashboard" }));
    const section = await screen.findByRole("region", { name: "Start of day" });
    fireEvent.click(within(section).getByRole("button", { name: /Simulate 9:00/ }));
    expect(await within(section).findByText(/Running now…/)).toBeTruthy();

    const notice = await screen.findByRole("alert", { name: "Notification: Start of day" });
    expect(notice.textContent).toMatch(/3 to do now/);
    const dashboard = within(section).getByTestId("priority-card");
    for (const name of ["Do now", "Today", "Waiting on you"]) expect(within(dashboard).getByRole("region", { name })).toBeTruthy();
    const doNow = within(dashboard).getByRole("region", { name: "Do now" });
    // Priya's sign-off came in on Slack and by email: one item, both sources.
    const pricing = within(doNow).getByText(/pricing page copy/).closest("li") as HTMLElement;
    expect(within(pricing).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "https://example.com/slack/s1",
      "https://example.com/gmail/g0",
    ]);
    expect(within(screen.getByRole("list", { name: "Agent channels" })).getByLabelText(/unread/)).toBeTruthy();

    fireEvent.click(within(notice).getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("heading", { level: 1, name: "# start-of-day" })).toBeTruthy();
    const messages = screen.getByTestId("messages");
    expect(within(messages).getByText(/Good morning Sam/)).toBeTruthy();
    expect(within(messages).getByTestId("priority-card")).toBeTruthy();
    const promise = within(messages).getByTestId("promise-card");
    expect(promise.textContent).toMatch(/Due Friday.*You said you'd send Lena the Q4 deck outline/s);
    expect(within(promise).getByRole("link").getAttribute("href")).toBe("https://example.com/drive/sync-notes");
    expect(within(messages).getByTestId("checklist-card")).toBeTruthy();
    // No raw run log outside Developer mode.
    expect(within(messages).queryByText(/Merged 2 duplicates/)).toBeNull();
  });

  it("posts an email draft (sign-off, Approve / Edit / Send) and a needs-context card whose answer becomes a draft", async () => {
    renderApp();
    await confirmStartOfDay();
    fireEvent.click(await screen.findByRole("button", { name: "Start of day, Scheduled 09:00" }));
    fireEvent.click(await screen.findByRole("button", { name: /Simulate 9:00/ }));
    const messages = screen.getByTestId("messages");
    const draft = await within(messages).findByTestId("email-draft-card");
    expect(within(draft).getByText("To Finance Team")).toBeTruthy();
    expect(within(draft).getByTestId("sign-off").textContent).toBe("— Nova, Sam Rivera's AI Agent");
    expect(within(draft).getByRole("link", { name: "AI Agent" }).getAttribute("href")).toBe("https://github.com/AISquare-Studio/rlxapp");
    const send = within(draft).getByRole("button", { name: /Send/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(within(draft).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(draft).getByLabelText("Message"), { target: { value: "Thanks. I'll bring the forecast Thursday." } });
    fireEvent.click(within(draft).getByRole("button", { name: "Save" }));
    expect(within(draft).getByText("Thanks. I'll bring the forecast Thursday.")).toBeTruthy();
    fireEvent.click(within(draft).getByRole("button", { name: "Approve" }));
    fireEvent.click(within(draft).getByRole("button", { name: /Send/ }));
    expect(within(draft).getByText("Sent")).toBeTruthy();

    const ask = within(messages).getByTestId("needs-context-card");
    expect(within(ask).getByText(/When are you free to meet him/)).toBeTruthy();
    fireEvent.change(within(ask).getByRole("textbox"), { target: { value: "Tuesday at 11:00" } });
    fireEvent.click(within(ask).getByRole("button", { name: "Reply" }));
    expect(within(ask).getByText(/You answered “Tuesday at 11:00”/)).toBeTruthy();
    const drafts = within(messages).getAllByTestId("email-draft-card");
    const reply = drafts[drafts.length - 1]!;
    expect(within(reply).getByText("To Aiko Tanaka")).toBeTruthy();
    expect(within(reply).getByText(/I'm free Tuesday at 11:00/)).toBeTruthy();
  });

  it("signs every draft as the personal agent, never as the helper agent that drafted it", async () => {
    // Owner decision (2026-11-25): always the personal agent's name, whichever helper did the work.
    const expected = "— Atlas, Sam Rivera's AI Agent";
    renderApp({ ...onboarded, agentName: "Atlas" });
    await confirmStartOfDay();
    fireEvent.click(await screen.findByRole("button", { name: "Start of day, Scheduled 09:00" }));
    fireEvent.click(await screen.findByRole("button", { name: /Simulate 9:00/ }));
    const messages = screen.getByTestId("messages");
    const draft = await within(messages).findByTestId("email-draft-card");
    // The helper posts as itself in its channel…
    expect(within(messages).getAllByText("Start of day", { selector: ".message__meta strong" }).length).toBeGreaterThan(0);
    // …but what goes out is signed by the personal agent.
    expect(within(draft).getByTestId("sign-off").textContent).toBe(expected);

    const ask = within(messages).getByTestId("needs-context-card");
    fireEvent.click(within(ask).getByRole("button", { name: "Thursday afternoon" }));
    const reply = within(messages).getAllByTestId("email-draft-card").at(-1)!;
    expect(within(reply).getByText("To Aiko Tanaka")).toBeTruthy();
    expect(within(reply).getByTestId("sign-off").textContent).toBe(expected);

    fireEvent.click(within(draft).getByRole("button", { name: "Approve" }));
    fireEvent.click(within(draft).getByRole("button", { name: /Send/ }));
    expect(within(draft).getByText(expected)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approvals" }));
    const drafts = await screen.findByTestId("drafts");
    const aiko = within(drafts).getByText("To Aiko Tanaka").closest("li") as HTMLElement;
    expect(within(aiko).getByTestId("sign-off").textContent).toBe(expected);
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    const activity = await screen.findByTestId("activity");
    const sent = within(activity).getByText(/I'll bring the updated forecast on Thursday/).closest("li") as HTMLElement;
    expect(within(sent).getByTestId("activity-sign-off").textContent).toBe(expected);
    for (const signOff of [...document.querySelectorAll("[data-testid='sign-off'], [data-testid='activity-sign-off']")]) {
      expect(signOff.textContent).not.toMatch(/Start of day|Slack agent|Gmail agent|Meetings agent|GTM agent/);
    }
  });

  it("holds a send for 10 seconds with Undo when the connector is on Auto", async () => {
    renderApp({ ...onboarded, sendModes: { ...onboarded.sendModes, "claude.ai Gmail": "auto" } });
    await confirmStartOfDay();
    fireEvent.click(await screen.findByRole("button", { name: "Start of day, Scheduled 09:00" }));
    fireEvent.click(await screen.findByRole("button", { name: /Simulate 9:00/ }));
    const draft = await screen.findByTestId("email-draft-card");
    vi.useFakeTimers();
    fireEvent.click(within(draft).getByRole("button", { name: /Send/ }));
    expect(within(draft).getByText(/Sending in 10 seconds/)).toBeTruthy();
    fireEvent.click(within(draft).getByRole("button", { name: "Undo" }));
    expect(within(draft).getByRole("button", { name: "Approve" })).toBeTruthy();
    fireEvent.click(within(draft).getByRole("button", { name: /Send/ }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(within(draft).getByText("Sent")).toBeTruthy();
  });
});
