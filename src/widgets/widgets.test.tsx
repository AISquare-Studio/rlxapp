import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { FakeEngine } from "../engine/fake/FakeEngine.ts";
import { browserPlatform, type Platform, type WidgetSource } from "../platform/index.ts";
import { WidgetHost } from "../platform/widgetHost.ts";
import { AppProvider } from "../state/AppProvider.tsx";
import { DEFAULT_SETTINGS } from "../state/model.ts";
import { AgentFrame, AGENT_WIDGET_SANDBOX } from "./AgentWidget.tsx";
import { withColorScheme } from "./colorScheme.ts";
import { GmailWidget, SlackDigestWidget } from "./ConnectorWidgets.tsx";
import { ClockWidget, PomodoroWidget, TimerWidget } from "./TimeWidgets.tsx";

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

  it("shows the clock in hours and minutes, so an idle Home repaints once a minute, not every second", () => {
    // A seconds display kept WebKit's GPU process at ~139 MB on an idle Home; minutes let it drop to ~16 MB.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 9, 41, 7));
    wrap(<ClockWidget />);
    const text = () => screen.getByTestId("clock-time").textContent ?? "";
    expect(text()).not.toMatch(/:\d{2}:\d{2}/);
    expect(text()).toMatch(/41/);
    const before = text();
    act(() => vi.advanceTimersByTime(20_000));
    expect(text()).toBe(before);
    act(() => vi.advanceTimersByTime(40_000));
    expect(text()).toMatch(/42/);
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
    // One quiet line: what the refresh cost; when, and how often, on hover or focus.
    expect(within(meta).getByTestId("slack-turn").textContent).toBe("Claude reviewed 3 new");
    expect(meta.querySelector(".reveal")?.textContent).toBe("checked just now · every 15 min");
    expect(meta.textContent).not.toMatch(/^\s*·|·\s*$/);
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
  it("shows all five sections, each as one calm line: its header, a count and a summary", async () => {
    wrap(<GmailWidget settingsOpen={false} />);
    for (const [section, count] of [
      ["Needs a reply", "2"],
      ["Important unread", "2"],
      ["Key senders", "3"],
      ["Daily digest", "2"],
      ["Today's meetings", "3"],
    ] as const) {
      const region = await screen.findByRole("region", { name: section });
      expect(within(region).getByRole("heading", { level: 4, name: section })).toBeTruthy();
      expect(region.querySelector(".gmail__count")?.textContent).toBe(count);
      expect(region.querySelector("details")?.open).toBe(false);
    }
    // No 'Drafted reply' chip repeating the Review draft action.
    expect(screen.queryByText("Drafted reply")).toBeNull();
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
    expect(turn()).toBe("Claude reviewed 3 new");
    refreshNow();
    await vi.waitFor(() => expect(turn()).toBe("Nothing new, no Claude usage"));
    refreshNow();
    // Let the second refresh finish: it found nothing new, so still no model turn.
    await vi.waitFor(async () => expect((await engine.runs()).filter((r) => r.kind === "widget_refresh" && r.state === "done")).toHaveLength(3));
    expect(turn()).toBe("Nothing new, no Claude usage");
    engine.simulateNewSlack(3);
    refreshNow();
    await vi.waitFor(() => expect(turn()).toBe("Claude reviewed 3 new"));
  });

  it("creates a draft from Draft reply that shows up in Approvals with the sign-off", async () => {
    render(<App platform={browserPlatform} engine={new FakeEngine({ stepMs: 20, seed: false })} initialSettings={settings} />);
    const gmail = await screen.findByRole("region", { name: "Gmail" });
    const needsReply = await within(gmail).findByRole("region", { name: "Needs a reply" });
    // Calm: the section is one line until opened; its items and their actions are inside.
    expect(within(needsReply).queryByRole("button", { name: "Draft reply" })).toBeNull();
    // (jsdom doesn't toggle <details> on a summary click; the browser checks do the real click.)
    act(() => {
      (needsReply.querySelector("details") as HTMLDetailsElement).open = true;
    });
    // Each item's action shows on hover or keyboard focus of the item.
    act(() => (needsReply.querySelector(".mail") as HTMLElement).focus());
    fireEvent.click(within(needsReply).getAllByRole("button", { name: "Draft reply" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: /^Approvals/ }));
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
    // The widget's own markup, behind the live theme's color-scheme (so the frame stays clear).
    expect(frame.getAttribute("srcdoc")).toBe('<meta name="color-scheme" content="dark"><p>hi</p>');
    expect(frame.dataset.scheme).toBe("dark");
  });

  it("states the theme's color-scheme in the widget document, after <head> or the doctype", () => {
    expect(withColorScheme("<!doctype html><html><head><title>x</title></head></html>", "light")).toBe(
      '<!doctype html><html><head><meta name="color-scheme" content="light"><title>x</title></head></html>',
    );
    expect(withColorScheme("<!doctype html><p>x</p>", "dark")).toBe('<!doctype html><meta name="color-scheme" content="dark"><p>x</p>');
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

describe("agent-made widget tile in the app (widget host)", () => {
  function nativeLike(source: WidgetSource, calls: string[]): Platform {
    const host = new WidgetHost({
      show: (b) => (calls.push(`show ${b.width}x${b.height}`), Promise.resolve()),
      hide: () => (calls.push("hide"), Promise.resolve()),
      mount: (ws) => (calls.push(`mount ${ws.map((w) => `${w.id}@${w.version}`).join(",")}`), Promise.resolve(ws.map((w) => w.id))),
      push: (id) => (calls.push(`push ${id}`), Promise.resolve()),
      register: () => Promise.resolve(""),
      onAction: () => () => {},
    });
    return {
      ...browserPlatform,
      runtime: "native",
      widgetSource: () => Promise.resolve(source),
      widgetHost: host,
      setWidgetsCovered: (covered) => void host.setCovered(covered),
    };
  }

  it("shows a calm off state, with the policy's reason behind a fold, while agent-made widgets are off", async () => {
    const platform = nativeLike({ off: "off on macOS until the isolation probe passes there" }, []);
    render(<App platform={platform} engine={new FakeEngine({ stepMs: 20, seed: false })} initialSettings={settings} />);
    const tile = await screen.findByRole("region", { name: "Open pull requests" });
    expect(await within(tile).findByText("Agent-made widgets are off here for now.")).toBeTruthy();
    expect(within(tile).getByTestId("agent-widget-off-reason").textContent).toBe(
      "Agent-made widgets are off on macOS until the isolation probe passes there.",
    );
    expect(tile.querySelector("iframe")).toBeNull();
  });

  it("places the widgets webview over its tile, mounts and feeds it, and hides it while a modal is open", async () => {
    const calls: string[] = [];
    const platform = nativeLike({ host: { id: "w-prs", version: 1 } }, calls);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 360, y: 400, width: 280, height: 200 }));
    try {
      render(<App platform={platform} engine={new FakeEngine({ stepMs: 20, seed: false })} initialSettings={settings} />);
      await screen.findByTestId("agent-widget-host-slot");
      await vi.waitFor(() => expect(calls).toContain("push w-prs"));
      expect(calls.slice(0, 2)).toEqual(["show 280x200", "mount w-prs@1"]);
      expect(document.querySelector("iframe[title='Open pull requests']")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /Add widget/ }));
      await vi.waitFor(() => expect(calls.at(-1)).toBe("hide"));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Add a widget" })).getByRole("button", { name: "Close" }));
      await vi.waitFor(() => expect(calls.at(-1)).toBe("show 280x200"));
    } finally {
      rect.mockRestore();
    }
  });
});
