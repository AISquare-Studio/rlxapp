# Native end-to-end tests

These test the built app, not the web UI on Vite. Two parts:

- **The widget isolation probe** (docs/architecture.md §5.3) runs on every OS. The test build (cargo feature `e2e`) probes itself and writes a report, so it needs no WebDriver. `native/probe.mjs` launches it, and `native/probe-rules.mjs` judges the report. There is one rule for every channel on every OS:
  - Raw channels (`__TAURI_INTERNALS__`, `chrome.webview`, `webkit.messageHandlers`, the `ipc://` fetch) may exist and may deliver. The probe never asserts they are absent.
  - From the widget host page and from inside a widget iframe, every app and plugin command must be rejected (by the missing key or the ACL), and the canary must record 0 calls. The channel fetch is the one exemption.
  - Self-navigation off the widget scheme must be blocked.
  - fetch, XHR, WebSocket, EventSource, beacons, images, prefetch and WebRTC aimed at a local listener must get 0 connections.
  - The per-OS agent-widget switch must be honoured.

  A *gate* check (⛔) decides whether agent-made widgets may be turned on for that OS. Preconnect is one today, because WebKit ignores CSP for it. A gate failure fails the run when agent-made widgets are on for that OS, or with `RLX_PROBE_STRICT=1`.
- **Screen checks** run on Windows and Linux: the built app under [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/), with msedgedriver for WebView2 and WebKitWebDriver for WebKitGTK. macOS has no WebDriver for WKWebView, so `scripts/mac-native-check.sh` covers the window, menu and tray there.

```sh
npm run e2e:build      # tauri build --debug --no-bundle --features e2e
npm run e2e            # the probe, then the screen checks (Windows/Linux); -- --only probe|screens
xvfb-run --auto-servernum npm run e2e   # Linux without a display
```

The screen checks need `tauri-driver` on PATH (`cargo install tauri-driver --locked`). On Windows they also need an msedgedriver that matches the WebView2 runtime: put it on PATH or set `TAURI_NATIVE_DRIVER`. CI installs both.

Output:
- `e2e/screenshots/<os>-<check>--<shot>.png`, from the screen checks and `scripts/mac-native-check.sh`;
- `e2e/results/isolation-probe-<os>.{json,md}`.

CI uploads both as the artifact `e2e-screenshots-<os>`, and adds the probe table to the job summary. `scripts/screenshot-gallery.sh --run <run-id>` downloads those artifacts and builds the PR gallery.

## Adding a screen check

Add one file to `native/checks/`. Files run in name order, each against a fresh launch of the app:

```js
// native/checks/20-settings.mjs
export const name = "settings";

export async function run({ session, shot, shotElement, assert }) {
  const button = await session.waitFor('[data-testid="nav-settings"]');
  await session.execute("arguments[0].click()", [button]);
  await session.waitFor('[data-testid="settings-screen"]');
  assert.equal(await session.title(), "rlx");
  await shot("settings"); // → e2e/screenshots/<os>-settings--settings.png
}
```

`session` (`native/webdriver.mjs`) has `waitFor(css)`, `find(css)`, `execute(script, args)`, `evaluate(expression)` (which awaits a promise in the page, e.g. a Tauri `invoke`), `title()`, `screenshot()` and `elementScreenshot(element)`.
