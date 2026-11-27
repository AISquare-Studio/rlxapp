import type { Page } from "@playwright/test";

/**
 * Opens the shell past onboarding, in a theme, with the defaults otherwise. The theme is the
 * host's setting, so it seeds the preview's fake host (main.tsx reads `rlxFakeHost`); onboarding
 * and Developer mode are this device's own, so they go in the device's storage.
 */
export async function openShell(
  page: Page,
  options: { theme?: "dark" | "light"; family?: "rlx" | "catppuccin" | "solarized"; devMode?: boolean; onboarded?: boolean } = {},
) {
  await page.addInitScript((opts) => {
    // Init scripts run in every frame; sandboxed widget frames have no storage, by design.
    if (window !== window.parent) return;
    (window as { rlxFakeHost?: unknown }).rlxFakeHost = { mode: opts.theme ?? "dark", family: opts.family ?? "rlx" };
    localStorage.setItem("rlx.device.v1", JSON.stringify({ onboarded: opts.onboarded ?? true, devMode: opts.devMode ?? false }));
  }, options);
  await page.goto("/");
}
