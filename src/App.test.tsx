import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { FakeEngine } from "./engine/fake/FakeEngine.ts";
import { browserPlatform } from "./platform/index.ts";
import { RLX_MARK_PATHS } from "./brand/mark.ts";
import { DEFAULT_SETTINGS, type Settings } from "./state/model.ts";

const onboarded: Settings = { ...DEFAULT_SETTINGS, onboarded: true };

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderApp(settings?: Settings, engine = new FakeEngine({ stepMs: 50 })) {
  render(<App platform={browserPlatform} engine={engine} initialSettings={settings} />);
  return engine;
}

describe("App", () => {
  it("starts with onboarding, and finishing it with a custom name shows that name in the sign-off", async () => {
    await renderApp({ ...DEFAULT_SETTINGS });
    fireEvent.click(await screen.findByRole("button", { name: "Get started" }));
    expect(await screen.findByText("Signed in")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const name = screen.getByLabelText("Agent name");
    fireEvent.change(name, { target: { value: "Atlas" } });
    expect(screen.getByTestId("sign-off").textContent).toBe("— Atlas, Sam Rivera's AI Agent");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to Home" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeTruthy();
    expect(screen.getAllByText(/Atlas/).length).toBeGreaterThan(0);
  });

  it("switches the mock Claude Code state between not installed, signed out and signed in", async () => {
    await renderApp({ ...DEFAULT_SETTINGS });
    fireEvent.click(await screen.findByRole("button", { name: "Get started" }));
    fireEvent.click(await screen.findByLabelText("Not installed"));
    expect(await screen.findByText("Claude Code isn't installed")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Signed out"));
    expect(await screen.findByRole("button", { name: "Sign in with Claude" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Signed in"));
    expect(await screen.findByText("Signed in", { selector: "strong" })).toBeTruthy();
  });

  it("lays out like a chat app: spaces, channels and DMs, the conversation and a detail panel", async () => {
    await renderApp(onboarded);
    const spaces = await screen.findByRole("navigation", { name: "Spaces" });
    expect(within(spaces).getByRole("button", { name: "Home" })).toBeTruthy();
    const dms = screen.getByRole("list", { name: "Direct messages" });
    expect(within(dms).getByRole("button", { name: "Manager, setup assistant" })).toBeTruthy();
    const channels = screen.getByRole("list", { name: "Agent channels" });
    expect(within(channels).getByRole("button", { name: "Slack agent, Asleep" })).toBeTruthy();
    expect(within(channels).getByRole("button", { name: "Meetings agent, Scheduled 08:45" })).toBeTruthy();
    expect(await within(channels).findByRole("button", { name: "GTM agent, Running" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Details" })).toBeTruthy();
    fireEvent.click(within(channels).getByRole("button", { name: "Slack agent, Asleep" }));
    expect(await screen.findByRole("heading", { level: 1, name: "# slack-agent" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message Slack agent" })).toBeTruthy();
    expect(within(screen.getByTestId("agent-details")).getByText("Every 15 min")).toBeTruthy();
  });

  it("shows every screen, with Developer (runs, fleet, board, panes) only while it is on", async () => {
    await renderApp(onboarded);
    const spaces = await screen.findByRole("navigation", { name: "Spaces" });
    for (const [label, heading] of [
      ["Agents", "Agents"],
      ["Approvals", "Approvals"],
      ["Dashboard", "Home"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
    }
    fireEvent.click(within(spaces).getByRole("button", { name: "New agent" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Manager" })).toBeTruthy();
    fireEvent.click(within(spaces).getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(within(spaces).queryByRole("button", { name: "Developer" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: /Developer mode/ }));
    fireEvent.click(within(spaces).getByRole("button", { name: "Developer" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Runs" })).toBeTruthy();
    for (const label of ["Fleet", "Board", "Panes"]) {
      fireEvent.click(within(screen.getByRole("navigation", { name: /navigation$/ })).getByRole("button", { name: label }));
      expect(await screen.findByRole("heading", { level: 1, name: label })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: /Open in terminal/ })).toBeTruthy();
    fireEvent.click(within(spaces).getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("switch", { name: /Developer mode/ }));
    expect(within(spaces).queryByRole("button", { name: "Developer" })).toBeNull();
  });

  it("moves an approved draft to the activity log with the sign-off", async () => {
    await renderApp(onboarded);
    fireEvent.click(await screen.findByRole("button", { name: "Approvals" }));
    const drafts = await screen.findByTestId("drafts");
    fireEvent.click(within(drafts).getAllByRole("button", { name: /Approve and send/ })[0]!);
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    const activity = await screen.findByTestId("activity");
    expect(within(activity).getByText(/I can own the press kit/)).toBeTruthy();
    expect(within(activity).getAllByTestId("activity-sign-off")[0]?.textContent).toBe("— Nova, Sam Rivera's AI Agent");
  });

  it("asks for a typed risk confirmation before turning Auto on", async () => {
    await renderApp(onboarded);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const slack = screen.getByRole("group", { name: "Slack" });
    fireEvent.click(within(slack).getByLabelText("Auto"));
    const dialog = screen.getByRole("dialog", { name: "Turn on Auto for Slack?" });
    expect(within(dialog).getByText("This is risky.")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Turn on Auto" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type AUTO to confirm"), { target: { value: "AUTO" } });
    fireEvent.click(confirm);
    expect(screen.getByText(/Auto is on: messages to Slack/)).toBeTruthy();
  });

  it("applies the theme and density to the document", async () => {
    await renderApp(onboarded);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByLabelText("Light"));
    expect(document.documentElement.dataset.theme).toBe("rlx-light");
    fireEvent.click(screen.getByLabelText("Solarized"));
    expect(document.documentElement.dataset.theme).toBe("solarized-light");
    fireEvent.click(screen.getByLabelText("Compact"));
    expect(document.documentElement.dataset.density).toBe("compact");
    fireEvent.click(screen.getByLabelText("Violet"));
    expect(document.documentElement.style.getPropertyValue("--rlx-accent")).toBe("#6A3FC8");
  });

  it("streams a run's raw log and cancels it, in Developer mode only", async () => {
    const engine = await renderApp({ ...onboarded, devMode: true });
    fireEvent.click(await screen.findByRole("button", { name: "Developer" }));
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Draft the launch email" } });
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Draft the launch email" })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(/Finished: cancelled/)).toBeTruthy();
    const runs = await engine.runs();
    expect(runs.find((r) => r.title === "Draft the launch email")?.state).toBe("failed");
  });

  it("draws the title bar's and the About box's mark from rlx-logo.svg's paths", async () => {
    await renderApp(onboarded);
    await screen.findByRole("heading", { level: 1, name: "Home" });
    const header = [...document.querySelectorAll(".titlebar__mark path")].map((p) => p.getAttribute("d"));
    expect(header).toEqual([...RLX_MARK_PATHS]);
    fireEvent.click(screen.getByRole("button", { name: "About rlx" }));
    const about = screen.getByRole("dialog", { name: "About rlx" });
    expect([...about.querySelectorAll("path")].map((p) => p.getAttribute("d"))).toContain(RLX_MARK_PATHS[0]);
    expect(await within(about).findByText(/browser preview/)).toBeTruthy();
  });
});

describe("budget measurement", () => {
  it("opens on Home and saves nothing when launched under the startup probe", async () => {
    const platform = { ...browserPlatform, appInfo: () => browserPlatform.appInfo().then((info) => ({ ...info, measuring: true })) };
    render(<App platform={platform} engine={new FakeEngine({ stepMs: 50 })} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeTruthy();
    expect(localStorage.getItem("rlx.settings.v1")).toBeNull();
  });
});

describe("rlx service settings", () => {
  it("toggles Start rlx at login and the menu-bar icon through the engine, on by default", async () => {
    const engine = new FakeEngine({ stepMs: 50 });
    render(<App platform={browserPlatform} engine={engine} initialSettings={onboarded} />);
    fireEvent.click(within(await screen.findByRole("navigation", { name: "Spaces" })).getByRole("button", { name: "Settings" }));
    const login = (await screen.findByRole("switch", { name: "Start rlx at login" })) as HTMLInputElement;
    await vi.waitFor(() => expect(login.checked).toBe(true));
    fireEvent.click(login);
    await vi.waitFor(() => expect(login.checked).toBe(false));
    await expect(engine.hostSettings()).resolves.toMatchObject({ startAtLogin: false });
    fireEvent.click(screen.getByLabelText("Template"));
    await vi.waitFor(async () => expect(await engine.hostSettings()).toMatchObject({ serviceTrayIcon: "template" }));
    // Another client of the same host changes it: the switch follows.
    await engine.updateHostSettings({ startAtLogin: true });
    await vi.waitFor(() => expect(login.checked).toBe(true));
    // Nothing about the service is stored in the app's own settings.
    expect(localStorage.getItem("rlx.settings.v1") ?? "").not.toMatch(/startAtLogin|serviceTrayIcon/);
  });
});
