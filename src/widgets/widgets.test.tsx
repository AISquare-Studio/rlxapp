import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { FakeEngine } from "../engine/fake/FakeEngine.ts";
import { browserPlatform } from "../platform/index.ts";
import { AppProvider } from "../state/AppProvider.tsx";
import { DEFAULT_SETTINGS } from "../state/model.ts";
import { AgentFrame, AGENT_WIDGET_SANDBOX } from "./AgentWidget.tsx";
import { GmailWidget, SlackDigestWidget } from "./ConnectorWidgets.tsx";
import { PomodoroWidget, TimerWidget } from "./TimeWidgets.tsx";

const settings = { ...DEFAULT_SETTINGS, onboarded: true };

function wrap(children: ReactNode, engine = new FakeEngine({ stepMs: 20, seed: false })) {
  return render(
    <AppProvider engine={engine} developer={engine} platform={browserPlatform} initialSettings={settings}>
      {children}
    </AppProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("time widgets", () => {
  it("runs a pomodoro: start counts down, pause holds, reset returns to 25:00", () => {
    vi.useFakeTimers();
    wrap(<PomodoroWidget />);
    expect(screen.getByTestId("pomodoro-display").textContent).toBe("25:00");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByTestId("pomodoro-display").textContent).toBe("24:57");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByTestId("pomodoro-display").textContent).toBe("24:57");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByTestId("pomodoro-display").textContent).toBe("25:00");
  });

  it("moves from focus to a break when a session ends, and counts it", () => {
    vi.useFakeTimers();
    wrap(<PomodoroWidget />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    act(() => vi.advanceTimersByTime(25 * 60 * 1000));
    expect(screen.getByText("Break")).toBeTruthy();
    expect(screen.getByText("Sessions done today: 1")).toBeTruthy();
  });

  it("runs a timer", () => {
    vi.useFakeTimers();
    wrap(<TimerWidget />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByTestId("timer-display").textContent).toBe("04:58");
  });
});

describe("Slack digest", () => {
  it("shows when it last checked and its interval, defaulting to 15 minutes, and a reason on every needs-you item", async () => {
    wrap(<SlackDigestWidget settingsOpen={false} />);
    const meta = await screen.findByTestId("slack-meta");
    await screen.findByText(/Priya Shah/);
    expect(meta.textContent).toBe("checked just now · model turn: Claude reviewed 3 new · every 15 min");
    expect(meta.querySelector(".reveal")?.textContent).toBe(" · every 15 min");
    const items = document.querySelectorAll(".feed__item--needs-you");
    expect(items.length).toBe(3);
    for (const item of items) {
      expect(within(item as HTMLElement).getByTestId("needs-you-why").textContent).toMatch(/^Needs you: .+/);
    }
  });

  it("lets the interval be changed", async () => {
    wrap(<SlackDigestWidget settingsOpen />);
    fireEvent.change(await screen.findByLabelText("Slack digest interval"), { target: { value: "30" } });
    expect(await screen.findByText(/every 30 min/)).toBeTruthy();
  });
});

describe("Gmail dashboard", () => {
  it("shows all five sections", async () => {
    wrap(<GmailWidget settingsOpen={false} />);
    for (const section of ["Needs a reply", "Important unread", "Key senders", "Daily digest", "Today's meetings"]) {
      expect(await screen.findByRole("region", { name: section })).toBeTruthy();
    }
  });

  it("refreshes silently with no model turn, and takes one only when something is new", async () => {
    const engine = new FakeEngine({ stepMs: 20, seed: false });
    wrap(<SlackDigestWidget settingsOpen={false} />, engine);
    const turn = () => screen.getByTestId("slack-turn").textContent;
    const refreshNow = () => {
      fireEvent.click(screen.getByRole("button", { name: "More actions for Slack digest" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Refresh now" }));
    };
    await screen.findByText(/Priya Shah/);
    expect(turn()).toBe("model turn: Claude reviewed 3 new");
    refreshNow();
    await vi.waitFor(() => expect(turn()).toBe("nothing new, no Claude usage"));
    refreshNow();
    await vi.waitFor(() => expect(screen.getByTestId("slack-meta").textContent).toMatch(/^checked/));
    expect(turn()).toBe("nothing new, no Claude usage");
    engine.simulateNewSlack(3);
    refreshNow();
    await vi.waitFor(() => expect(turn()).toBe("model turn: Claude reviewed 3 new"));
  });

  it("creates a draft from Draft reply that shows up in Approvals with the sign-off", async () => {
    render(<App platform={browserPlatform} engine={new FakeEngine({ stepMs: 20, seed: false })} initialSettings={settings} />);
    const gmail = await screen.findByRole("region", { name: "Gmail" });
    const needsReply = await within(gmail).findByRole("region", { name: "Needs a reply" });
    fireEvent.click(within(needsReply).getAllByRole("button", { name: "Draft reply" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Approvals" }));
    const drafts = await screen.findByTestId("drafts");
    expect(within(drafts).getByText("To Tom Okafor")).toBeTruthy();
    const draft = within(drafts).getByText("To Tom Okafor").closest("li") as HTMLElement;
    expect(within(draft).getByTestId("sign-off").textContent).toBe("— Nova, Sam Rivera's AI Agent");
  });
});

describe("agent-made widget", () => {
  it("renders in an iframe sandboxed to scripts only, without allow-same-origin", async () => {
    wrap(<AgentFrame id="test" version={1} title="Test widget" html="<p>hi</p>" data={[]} />);
    const frame = (await screen.findByTitle("Test widget")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe(AGENT_WIDGET_SANDBOX);
    expect(AGENT_WIDGET_SANDBOX.split(/\s+/)).toEqual(["allow-scripts"]);
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toBe("<p>hi</p>");
  });
});

describe("Home", () => {
  it("adds, reorders and removes widgets", async () => {
    render(<App platform={browserPlatform} engine={new FakeEngine({ stepMs: 20, seed: false })} initialSettings={settings} />);
    await screen.findByRole("heading", { level: 1, name: "Home" });
    const count = () => document.querySelectorAll(".widget").length;
    const before = count();
    fireEvent.click(screen.getByRole("button", { name: "Add widget" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add a widget" })).getByRole("button", { name: /^Clock/ }));
    expect(count()).toBe(before + 1);

    const first = () => document.querySelector(".widget")?.getAttribute("aria-label");
    expect(first()).toBe("Slack digest");
    fireEvent.click(screen.getByRole("button", { name: "Move Slack digest later" }));
    expect(first()).toBe("Gmail");

    fireEvent.click(screen.getByRole("button", { name: "Remove Gmail" }));
    expect(count()).toBe(before);
    expect(screen.queryByRole("region", { name: "Gmail" })).toBeNull();
  });

  it("renders the generic per-connector widget from its manifest and gives every control a name", async () => {
    render(<App platform={browserPlatform} engine={new FakeEngine({ stepMs: 20, seed: false })} initialSettings={settings} />);
    const linear = await screen.findByRole("region", { name: "Linear" });
    expect(await within(linear).findByTestId("generic-widget")).toBeTruthy();
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("aria-label") ?? button.textContent?.trim()).toBeTruthy();
    }
  });
});
