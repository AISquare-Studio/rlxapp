import { defineConfig, devices } from "@playwright/test";

// Browser checks of the UI shell in the browser preview (Vite + FakeEngine): `npm run e2e:web`.
// `npm run e2e` is the native tauri-driver suite (task #16).
export default defineConfig({
  testDir: "e2e/web",
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
