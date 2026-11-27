import { expect, test } from "@playwright/test";
import { openShell } from "./helpers.ts";
import { readPng } from "./png.ts";

// The agent-made widget's frame must show the theme through it, never an opaque white canvas
// (ui-tester #1752: labels at 1.1:1 in every dark theme). Sampled from real screenshots.

const cases = [
  { name: "rlx (dark)", theme: "dark", family: "rlx", panel: [0x1a, 0x1b, 0x20] },
  { name: "Catppuccin Mocha", theme: "dark", family: "catppuccin", panel: [0x31, 0x32, 0x44] },
  { name: "Solarized Dark", theme: "dark", family: "solarized", panel: null },
  { name: "rlx light", theme: "light", family: "rlx", panel: [0xec, 0xee, 0xf2] },
] as const;

for (const c of cases) {
  test(`the agent-made widget frame is see-through in ${c.name}`, async ({ page }) => {
    await openShell(page, { theme: c.theme, family: c.family });
    const frame = page.locator('iframe[title="Open pull requests"]');
    await expect(frame).toBeVisible();
    await expect(page.frameLocator('iframe[title="Open pull requests"]').locator(".row").first()).toBeVisible();
    const shot = readPng(await frame.screenshot());
    // The bottom-right corner is past the chart: it shows whatever is behind the frame.
    const [r, g, b] = shot.at(shot.width - 4, shot.height - 4);
    expect([r, g, b], "the frame painted an opaque white canvas").not.toEqual([255, 255, 255]);
    if (c.theme === "dark") expect(Math.max(r, g, b), `background ${[r, g, b]} is not dark`).toBeLessThan(110);
    if (c.panel) {
      for (const [i, channel] of [r, g, b].entries()) expect(Math.abs(channel - (c.panel[i] ?? 0))).toBeLessThanOrEqual(6);
    }
  });
}
