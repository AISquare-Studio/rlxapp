import { expect, test, type Page } from "@playwright/test";
import { openShell } from "./helpers.ts";

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("onboarding: welcome, Claude Code status, naming the agent with a live sign-off, done", async ({ page }) => {
  const errors = watchErrors(page);
  await openShell(page, { onboarded: false });
  await page.getByRole("button", { name: "Get started" }).click();
  for (const state of ["Not installed", "Signed out", "Signed in"]) {
    await page.getByText(state, { exact: true }).click();
  }
  await expect(page.getByTestId("claude-status")).toContainText("Signed in");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Agent name").fill("Atlas");
  await expect(page.getByTestId("sign-off")).toHaveText("— Atlas, Sam Rivera's AI Agent");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Go to Home" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("every screen is reachable by clicking from Home, with no console errors", async ({ page }) => {
  const errors = watchErrors(page);
  await openShell(page);
  const spaces = page.getByRole("navigation", { name: "Spaces" });
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.locator('iframe[title="Open pull requests"]')).toBeVisible();

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();

  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  await page.getByRole("tab", { name: /Standing approvals/ }).click();
  await expect(page.getByRole("button", { name: "Revoke" }).first()).toBeVisible();
  await page.getByRole("tab", { name: /Activity/ }).click();
  await expect(page.getByTestId("activity-sign-off").first()).toBeVisible();

  await page.getByRole("list", { name: "Agent channels" }).getByRole("button", { name: /^Gmail agent/ }).click();
  await page.getByLabel("Message Gmail agent").fill("What needs me today?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("messages")).toContainText("Priya");

  await spaces.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: /Developer mode/ }).check();
  await spaces.getByRole("button", { name: "Developer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
  for (const state of ["Queued", "Running", "Needs you", "Done", "Failed"]) {
    await expect(page.getByRole("region", { name: state })).toBeVisible({ timeout: 10_000 });
  }
  await page.getByRole("region", { name: "Running" }).getByRole("button").first().click();
  await expect(page.getByTestId("task-log")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  for (const name of ["Fleet", "Board", "Panes"]) {
    await page.getByRole("navigation", { name: /navigation$/ }).getByRole("button", { name }).click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  }
  await expect(page.getByTestId("pane-output")).toContainText("Build the pricing table");
  await page.getByRole("button", { name: /Open in terminal/ }).click();
  await expect(page.getByText(/Opening rlx in your terminal/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("every control is reachable with Tab and shows a focus ring", async ({ page }) => {
  await openShell(page);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  const seen = new Set<string>();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(async () => {
      // Let React render any focus state (the widget wrapper's ring) before reading styles.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      // A focused iframe's ring is drawn by its wrapper (:focus-within).
      const style = getComputedStyle(el.tagName === "IFRAME" && el.parentElement ? el.parentElement : el);
      return { key: `${el.tagName}:${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)}`, outline: style.outlineStyle };
    });
    if (!info) continue;
    expect(info.outline, `${info.key} has no visible focus ring`).not.toBe("none");
    seen.add(info.key);
  }
  expect(seen.size).toBeGreaterThan(20);
});

test("prefers-reduced-motion turns animations off", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openShell(page);
  await page.locator(".rail__button").first().waitFor();
  const duration = await page.evaluate(() => getComputedStyle(document.querySelector(".rail__button")!).transitionDuration);
  expect(duration).toBe("0s");
});
