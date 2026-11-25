import { expect, test } from "@playwright/test";
import { openShell } from "./helpers.ts";

// Acceptance 3: an agent-made widget's iframe cannot read the app's document.
test("an agent-made widget is sandboxed: no parent.document, no storage, but it still renders its data", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await openShell(page);

  const iframe = page.locator('iframe[title="Open pull requests"]');
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  expect(await iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");

  const frame = await (await iframe.elementHandle())!.contentFrame();
  expect(frame).not.toBeNull();
  // It renders the data the app sent it over the MessageChannel bridge.
  await expect(frame!.locator(".row")).toHaveCount(4);

  const probe = await frame!.evaluate(() => {
    const attempt = (read: () => unknown) => {
      try {
        read();
        return "readable";
      } catch (error) {
        return `blocked: ${(error as Error).name}`;
      }
    };
    return {
      origin: window.origin,
      parentDocument: attempt(() => window.parent.document.title),
      topDocument: attempt(() => window.top!.document.body),
      storage: attempt(() => window.localStorage.getItem("rlx.settings.v1")),
      cookie: attempt(() => document.cookie),
    };
  });
  expect(probe.origin).toBe("null");
  expect(probe.parentDocument).toBe("blocked: SecurityError");
  expect(probe.topDocument).toBe("blocked: SecurityError");
  expect(probe.storage).toBe("blocked: SecurityError");
  expect(probe.cookie).toBe("blocked: SecurityError");
  expect(errors).toEqual([]);
});
