import { expect, test, type Page } from "@playwright/test";

// The owner's state survives a relaunch, and an upgrade from rc's single settings key, in the
// browser preview: the host's part in the preview's fake-host store, the device's in rlx.device.v1.

async function expectRestored(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "rlx-light");
  const nav = page.getByRole("navigation", { name: "Navigation" });
  await expect(nav.getByRole("button", { name: "Developer" })).toBeVisible();
  const channels = page.getByRole("list", { name: "Agent channels" });
  await expect(channels.getByRole("button", { name: "Meetings agent, Paused" })).toBeVisible();
  await expect(channels.getByRole("button", { name: "Start of day, Scheduled 09:00" })).toBeVisible();
  await expect(page.getByLabel("Your agent")).toContainText("Kai");
}

test("a relaunch keeps the agent's name, the theme, Developer mode, a paused agent and one made with the manager", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByTestId("claude-status")).toContainText("Signed in");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Agent name").fill("Kai");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Go to Home" }).click();

  const nav = page.getByRole("navigation", { name: "Navigation" });
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "More actions for Meetings agent" }).click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await page.getByRole("button", { name: "Manager, setup assistant" }).click();
  await page.getByLabel("Message Manager").fill("Every weekday at 9 give me a start of day briefing");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByTestId("proposal-card").getByRole("button", { name: "Confirm" }).click();
  await nav.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await page.getByRole("switch", { name: /Developer mode/ }).check();
  await nav.getByRole("button", { name: "Dashboard" }).click();

  await page.reload();
  await expectRestored(page);
});

test("an upgrade from rc migrates rlx.settings.v1 once: an onboarded owner stays on Home with Developer, and nothing is lost", async ({ page }) => {
  const rcAgent = (id: string, name: string, connectors: string[], patch: Record<string, unknown> = {}) => ({
    id,
    name,
    avatar: name[0],
    purpose: `${name} things`,
    connectors,
    schedule: { kind: "interval", everyMin: 30 },
    mode: "silent",
    outputs: ["widget"],
    state: "asleep",
    ...patch,
  });
  // What rc's shell stored: every setting in one key, agents included, connectors as people name them.
  const rc = JSON.stringify({
    onboarded: true,
    devMode: true,
    agentName: "Kai",
    ownerName: "Ana Li",
    family: "rlx",
    mode: "light",
    agents: [
      rcAgent("slack-agent", "Slack agent", ["Slack"]),
      rcAgent("meetings-agent", "Meetings agent", ["Google Calendar", "Meet transcripts (Google Drive)"], { schedule: { kind: "daily", at: "08:45" }, state: "paused" }),
      rcAgent("start-of-day", "Start of day", ["Google Calendar", "Meet transcripts (Google Drive)", "Gmail", "Slack"], {
        role: "briefing",
        schedule: { kind: "weekdays", at: "09:00" },
        mode: "loud",
        outputs: ["channel", "dashboard"],
      }),
    ],
  });
  await page.addInitScript((legacy) => {
    // Once per tab, as rc left it; a reload must not put it back.
    if (window !== window.parent || sessionStorage.getItem("rc-seeded")) return;
    sessionStorage.setItem("rc-seeded", "1");
    localStorage.setItem("rlx.settings.v1", legacy);
  }, rc);
  await page.goto("/");
  await expectRestored(page);
  await expect(page.getByText("Ana's space")).toBeVisible();

  const stored = await page.evaluate(() => ({
    legacy: localStorage.getItem("rlx.settings.v1"),
    device: JSON.parse(localStorage.getItem("rlx.device.v1") ?? "null") as unknown,
    host: JSON.parse(localStorage.getItem("rlx.fake-host.v1") ?? "null") as { agents: { id: string; connectors: string[] }[] } | null,
  }));
  expect(stored.legacy).toBeNull();
  expect(stored.device).toEqual({ onboarded: true, devMode: true, engineHome: "" });
  expect(stored.host?.agents.find((a) => a.id === "start-of-day")?.connectors).toEqual([
    "claude.ai Google Calendar",
    "claude.ai Google Drive",
    "claude.ai Gmail",
    "claude.ai Slack",
  ]);

  await page.reload();
  await expectRestored(page);
});
