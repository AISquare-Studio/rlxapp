import type { Page } from "@playwright/test";

/** Opens the shell past onboarding, in a theme, with the defaults otherwise. */
export async function openShell(page: Page, options: { theme?: "dark" | "light"; devMode?: boolean; onboarded?: boolean } = {}) {
  await page.addInitScript((opts) => {
    // Init scripts run in every frame; sandboxed widget frames have no storage, by design.
    if (window !== window.parent) return;
    localStorage.setItem(
      "rlx.settings.v1",
      JSON.stringify({ onboarded: opts.onboarded ?? true, mode: opts.theme ?? "dark", family: "rlx", devMode: opts.devMode ?? false }),
    );
  }, options);
  await page.goto("/");
}
