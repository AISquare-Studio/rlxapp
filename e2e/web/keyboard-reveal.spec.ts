import { expect, test, type Locator, type Page } from "@playwright/test";
import { openShell } from "./helpers.ts";

// Secondary text hidden behind hover must appear on keyboard focus too (rule-calm-design;
// reviewer #1417 item 4). Each check reaches its target by pressing Tab, never by clicking.

async function tabTo(page: Page, target: Locator, max = 200): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press("Tab");
    const there = await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
    if (there) return;
  }
  throw new Error("Tab never reached the target");
}

test("Home: an agent's next wake, a Slack item's time and the digest's interval show on keyboard focus", async ({ page }) => {
  await openShell(page);
  const wake = page.locator("#wake-meetings-agent");
  await expect(wake).toHaveCSS("opacity", "0");
  await tabTo(page, page.getByRole("button", { name: "Meetings agent, Scheduled 08:45" }));
  await expect(wake).toHaveCSS("opacity", "1");
  await expect(page.getByRole("button", { name: "Meetings agent, Scheduled 08:45" })).toHaveAttribute("aria-describedby", "wake-meetings-agent");

  const slack = page.getByRole("region", { name: "Slack digest" });
  await expect(slack.getByTestId("slack-turn")).toBeVisible();
  const meta = slack.getByTestId("slack-meta");
  await expect(meta.locator(".reveal")).toHaveCSS("opacity", "0");
  await tabTo(page, meta);
  await expect(meta.locator(".reveal")).toHaveCSS("opacity", "1");

  const item = slack.locator(".feed__item").first();
  await expect(item.locator(".reveal")).toHaveCSS("opacity", "0");
  await tabTo(page, item);
  await expect(item.locator(".reveal")).toHaveCSS("opacity", "1");
});

test("Channel: a message's time and a priority item's reason show on keyboard focus; Escape hides the reason", async ({ page }) => {
  await openShell(page);
  await page.getByRole("button", { name: "Manager, setup assistant" }).click();
  await page.getByLabel("Message Manager").fill("Every weekday at 9 give me a start of day briefing");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByTestId("proposal-card").getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "Dashboard" }).click();
  await page.getByRole("region", { name: "Start of day" }).getByRole("button", { name: /Simulate 9:00/ }).click();
  await page.getByRole("alert").getByRole("button", { name: "Open" }).click();
  const messages = page.getByTestId("messages");
  await expect(messages).toContainText("Good morning Sam");

  const first = messages.locator("li.message").filter({ hasText: "Good morning Sam" });
  await expect(first.locator("time.reveal")).toHaveCSS("opacity", "0");
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await tabTo(page, first);
  await expect(first.locator("time.reveal")).toHaveCSS("opacity", "1");

  const row = messages.locator(".priority__item").filter({ hasText: "pricing page copy" });
  const tip = row.getByTestId("why-tip");
  await expect(tip).toBeHidden();
  await tabTo(page, row);
  await expect(tip).toBeVisible();
  const describedBy = await row.getAttribute("aria-describedby");
  expect(describedBy).toBe(await tip.getAttribute("id"));
  await expect(tip).toHaveText(/Asked twice/);
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(row).toBeFocused();
});
