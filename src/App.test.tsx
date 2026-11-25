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

  it("shows every main screen from the rail, with Developer mode only while it is on", async () => {
    await renderApp(onboarded);
    const rail = await screen.findByRole("navigation", { name: "Sections" });
    for (const [label, heading] of [
      ["Tasks", "Tasks"],
      ["Approvals", "Approvals"],
      ["Chat", "Chat with Nova"],
      ["Settings", "Settings"],
      ["Home", "Home"],
    ] as const) {
      fireEvent.click(within(rail).getByRole("button", { name: label }));
      expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
    }
    expect(within(rail).queryByRole("button", { name: "Fleet" })).toBeNull();
    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("switch"));
    for (const label of ["Fleet", "Board", "Panes"]) {
      fireEvent.click(within(rail).getByRole("button", { name: label }));
      expect(await screen.findByRole("heading", { level: 1, name: label })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: /Open in terminal/ })).toBeTruthy();
    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("switch"));
    expect(within(rail).queryByRole("button", { name: "Fleet" })).toBeNull();
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

  it("streams a task's log and cancels it", async () => {
    const engine = await renderApp(onboarded);
    fireEvent.click(await screen.findByRole("button", { name: "Tasks" }));
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
