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
    const rail = page.getByRole("navigation", { name: "Sections" });
    await page.locator('iframe[title="Open pull requests"]').waitFor();
    await page.waitForTimeout(800);
    await shot(page, `${label}-05-home`);
    await page.getByRole("button", { name: /Ask Nova to make a widget/ }).first().click();
    await page.getByRole("button", { name: "Make it" }).click();
    await page.getByRole("button", { name: "Add to Home" }).waitFor();
    await shot(page, `${label}-06-ask-agent-widget`);
    await page.getByRole("button", { name: "Close" }).click();
    await rail.getByRole("button", { name: "Tasks" }).click();
    await page.waitForTimeout(1500);
    await shot(page, `${label}-07-tasks`);
    await page.getByRole("region", { name: "Running" }).getByRole("button").first().click();
    await page.waitForTimeout(2500);
    await shot(page, `${label}-08-task-detail`);
    await rail.getByRole("button", { name: "Approvals" }).click();
    await shot(page, `${label}-09-approvals-drafts`);
    await page.getByRole("tab", { name: /Standing approvals/ }).click();
    await shot(page, `${label}-10-approvals-standing`);
    await page.getByRole("tab", { name: /Activity/ }).click();
    await shot(page, `${label}-11-approvals-activity`);
    await rail.getByRole("button", { name: "Chat" }).click();
    await page.getByLabel("Message Nova").fill("What needs me today?");
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForTimeout(1200);
    await shot(page, `${label}-12-chat`);
    await rail.getByRole("button", { name: "Settings" }).click();
    await shot(page, `${label}-13-settings`);
    const slack = page.getByRole("group", { name: "Slack" });
    await slack.getByText("Auto", { exact: true }).click();
    await shot(page, `${label}-14-settings-auto-risk`);
    await page.getByRole("button", { name: "Keep drafts" }).click();
    for (const [name, file] of [
      ["Fleet", "15-fleet"],
      ["Board", "16-board"],
      ["Panes", "17-panes"],
    ] as const) {
      await rail.getByRole("button", { name }).click();
      await page.waitForTimeout(name === "Panes" ? 3000 : 300);
      await shot(page, `${label}-${file}`);
    }
    await page.getByRole("button", { name: "About rlx" }).click();
    await page.waitForTimeout(300);
    await shot(page, `${label}-18-about`);
  });
}
