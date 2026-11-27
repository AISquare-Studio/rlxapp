<p><img src="src/assets/rlx-logo.svg" alt="rlx" height="56"></p>

# rlxapp

**rlx** is a desktop app that runs [rlx](https://github.com/AISquare-Studio/rlx) agents in the background, with a friendly face for people who don't live in a terminal. This repository, rlxapp, holds its code.

Coming soon.

## Development

rlx is a [Tauri 2](https://v2.tauri.app) app. The Rust core lives in `src-tauri/` and the React + TypeScript UI, built with Vite, lives in `src/`.

### Prerequisites

- Node.js 24 or newer; `.nvmrc` pins the version CI uses. npm comes with Node.
- Rust through [rustup](https://rustup.rs). `rust-toolchain.toml` pins the version.
- The [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS:
  - macOS: Xcode Command Line Tools.
  - Windows: WebView2 and the MSVC build tools.
  - Linux: `libwebkit2gtk-4.1-dev` and the related packages.

### Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Install the web dependencies |
| `npm run tauri dev` | Run the desktop app with hot reload |
| `npm run dev` | Serve the UI alone in a browser at http://localhost:1420, with Tauri calls mocked |
| `npm run tauri build -- --bundles app` | Build an unsigned `rlx.app` into `src-tauri/target/release/bundle/macos/` |
| `npm run lint` / `npm run typecheck` / `npm test` | Lint (oxlint), typecheck (tsc) and test (Vitest) the UI |
| `cargo test` / `cargo clippy --all-targets -- -D warnings` | Test and lint the core (run in `src-tauri/`) |
| `npm run smoke -- <binary>` | Launch a built binary and check that it paints and stays up for 5 s |
| `npm run icons` | Regenerate the app icons and favicon from `src/assets/rlx-logo.svg` |
| `npm run e2e:web` | Browser checks of the UI shell in the browser preview, in Chromium (Playwright, `e2e/web`; run `npx playwright install chromium` once) |
| `npm run gallery` | Capture every screen in the rlx and rlx light themes into `docs/gallery/` |
| `scripts/measure-budgets.sh` | macOS: installer size, cold start and idle memory (phys_footprint) against the budgets |
| `node scripts/idle-memory.mjs <binary>` | Windows/Linux: idle memory (private working set / PSS), as CI runs it |
| `npm run e2e:build` then `npm run e2e` | Native end-to-end tests on the test build: the widget isolation probe on every OS, plus tauri-driver screen checks on Windows/Linux (see [e2e/README.md](e2e/README.md)) |
| `scripts/mac-native-check.sh` | macOS: window, second launch, app menu, no tray or login item, close, reopen and quit, captured window by window with `screencapture -l`, then the isolation probe |
| `scripts/screenshot-gallery.sh` | Turn local and CI screenshots into a markdown gallery for a PR body |

On macOS, local builds produce only the `.app`, and `src-tauri/tauri.macos.conf.json` makes that the default. Building a DMG opens Finder windows, so DMGs, and the Windows and Linux installers, are built in CI and attached to each run as artifacts.

The UI talks to the core only through `src/platform/`. When the UI runs in a plain browser, the adapter falls back to mocks. Colours are design tokens (`src/theme/`), and the default theme is rlx's own TUI palette.

### The UI shell

The UI runs on mock data through `FakeEngine` (`src/engine/fake/`), which implements the `Engine` interface from the architecture doc. The UI reaches agentic work only through that interface; `src/engine/adapter/native.ts` is the only module that calls into the Rust core.

- `App` takes interfaces only: `Engine`, `DeveloperEngine`, optional `DemoControls` (the preview's mock switches) and `Core`. `src/main.tsx` is the composition root, the one place that builds the fakes.
- `Core` (`src/core/types.ts`) owns the product state: settings, agents and their runs' outcomes, conversations, drafts and the send gate, standing approvals, activity and Pending. `FakeCore` (`src/core/fake/`) keeps the host's part in memory, as rlxd's settings API will; only device-local settings (`src/core/device.ts`) go to this device's storage.
- Runs carry `jobId` and `agentId`; connectors have one id everywhere, the claude.ai server name (`src/core/connectors.ts`).

- The app draws no tray icon: the one menu-bar / tray icon belongs to the rlx service (rlxd), whose menu has **Open rlx app**. Closing the window hides it (and the Dock icon on macOS) and keeps the app running for scheduled jobs; opening the app again, from the service tray, the Dock or a second launch, brings the same window back (single instance).
- **Start rlx at login** (Settings › rlx service) is the service's login registration, set through the Engine; the app registers no login item of its own.
- Agent-made widgets render in `<iframe sandbox="allow-scripts">` in the browser preview. In the app, the main window allows no frames; they render only in the widget host's `widgets` webview, and the host's policy keeps them off until the isolation probe passes (architecture §5.3). Built-ins render as React in the main window.
- Themes are CSS variables (`src/theme/tokens.css`), checked against `src/theme/themes.ts` and for WCAG contrast by tests.

### Budgets

| | Budget |
| --- | --- |
| Installer | ≤ 25 MB |
| Idle RAM | ≤ 150 MB |
| Cold start | ≤ 1.5 s on Apple silicon |

The header of `scripts/measure-budgets.sh` explains how each number is measured.

## Credits

The `r\x` mark is outlined from [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), © 2020 The JetBrains Mono Project Authors, under the SIL Open Font License 1.1.
