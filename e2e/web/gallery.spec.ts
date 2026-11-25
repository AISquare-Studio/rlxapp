import { test, type Page } from "@playwright/test";
import { openShell } from "./helpers.ts";

// The PR's screenshot gallery: every screen in the rlx theme and in rlx light.
// Runs only with GALLERY=1 (`npm run gallery`); writes docs/gallery/<theme>-<screen>.png.
test.skip(!process.env.GALLERY, "set GALLERY=1 to capture the gallery");

const shot = (page: Page, name: string) => page.screenshot({ path: `docs/gallery/${name}.png` });

for (const theme of ["dark", "light"] as const) {
  const label = theme === "dark" ? "rlx" : "rlx-light";

  test(`onboarding in ${label}`, async ({ page }) => {
    await openShell(page, { theme, onboarded: false });
    await page.getByRole("button", { name: "Get started" }).waitFor();
    await shot(page, `${label}-01-welcome`);
    await page.getByRole("button", { name: "Get started" }).click();
    await page.getByText("Signed out", { exact: true }).click();
    await shot(page, `${label}-02-claude-code`);
    await page.getByText("Signed in", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await shot(page, `${label}-03-name-your-agent`);
    await page.getByRole("button", { name: "Continue" }).click();
    await shot(page, `${label}-04-done`);
  });

  test(`main screens in ${label}`, async ({ page }) => {
    await openShell(page, { theme, devMode: true });
    const spaces = page.getByRole("navigation", { name: "Spaces" });
    await page.locator('iframe[title="Open pull requests"]').waitFor();
    await page.waitForTimeout(800);
    await shot(page, `${label}-05-home`);
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.waitForTimeout(300);
    await shot(page, `${label}-06-agents`);
    await page.getByRole("button", { name: "More actions for Meetings agent" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await shot(page, `${label}-07-agent-edit`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Manager, setup assistant" }).click();
    await shot(page, `${label}-08-manager`);
    await page.getByLabel("Message Manager").fill("Every weekday at 9 give me a start of day briefing");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByTestId("proposal-card").waitFor();
    await page.waitForTimeout(300);
    await shot(page, `${label}-09-manager-proposal`);
    await page.getByTestId("proposal-card").getByRole("button", { name: "Confirm" }).click();
    await page.waitForTimeout(300);
    await shot(page, `${label}-10-manager-confirmed`);

    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.getByRole("region", { name: "Start of day" }).getByRole("button", { name: /Simulate 9:00/ }).click();
    await page.getByRole("alert", { name: "Notification: Start of day" }).waitFor();
    await page.waitForTimeout(400);
    await shot(page, `${label}-11-home-briefing-notification`);
    await page.getByRole("alert").getByRole("button", { name: "Open" }).click();
    await page.waitForTimeout(400);
    await page.getByTestId("messages").evaluate((el) => el.scrollTo(0, 0));
    await shot(page, `${label}-12-start-of-day-channel`);
    await page.getByTestId("needs-context-card").scrollIntoViewIfNeeded();
    await shot(page, `${label}-13-draft-and-needs-context`);
    await page.getByTestId("needs-context-card").getByRole("button", { name: "Tuesday 11:00 or Wednesday 15:00" }).click();
    await page.waitForTimeout(300);
    await shot(page, `${label}-14-needs-context-answered`);

    await page.getByRole("list", { name: "Agent channels" }).getByRole("button", { name: /^Slack agent/ }).click();
    await page.getByLabel("Message Slack agent").fill("What needs me today?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForTimeout(1200);
    await shot(page, `${label}-15-agent-channel`);

    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.getByRole("button", { name: /Ask Nova to make a widget/ }).first().click();
    await page.getByRole("button", { name: "Make it" }).click();
    await page.getByRole("button", { name: "Add to Home" }).waitFor();
    await shot(page, `${label}-16-ask-agent-widget`);
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Approvals", exact: true }).click();
    await shot(page, `${label}-17-approvals-drafts`);
    await page.getByRole("tab", { name: /Standing approvals/ }).click();
    await shot(page, `${label}-18-approvals-standing`);
    await page.getByRole("tab", { name: /Activity/ }).click();
    await shot(page, `${label}-19-approvals-activity`);
    await spaces.getByRole("button", { name: "Settings" }).click();
    await shot(page, `${label}-20-settings`);
    const slack = page.getByRole("group", { name: "Slack" });
    await slack.getByText("Auto", { exact: true }).click();
    await page.getByRole("dialog", { name: "Turn on Auto for Slack?" }).waitFor();
    await page.waitForTimeout(300);
    await shot(page, `${label}-21-settings-auto-risk`);
    await page.getByRole("button", { name: "Keep drafts" }).click();

    await spaces.getByRole("button", { name: "Developer" }).click();
    await page.waitForTimeout(1500);
    await shot(page, `${label}-22-dev-runs`);
    await page.getByRole("region", { name: "Running" }).getByRole("button").first().click();
    await page.waitForTimeout(2500);
    await shot(page, `${label}-23-dev-run-log`);
    for (const [name, file] of [
      ["Fleet", "24-dev-fleet"],
      ["Board", "25-dev-board"],
      ["Panes", "26-dev-panes"],
    ] as const) {
      await page.getByRole("navigation", { name: /navigation$/ }).getByRole("button", { name }).click();
      await page.waitForTimeout(name === "Panes" ? 3000 : 300);
      await shot(page, `${label}-${file}`);
    }
    await page.getByRole("button", { name: "About rlx" }).click();
    await page.waitForTimeout(300);
    await shot(page, `${label}-27-about`);
  });
}
