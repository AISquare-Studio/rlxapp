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
| `scripts/measure-budgets.sh` | macOS: installer size, cold start and idle memory (phys_footprint) against the budgets |
| `node scripts/idle-memory.mjs <binary>` | Windows/Linux: idle memory (private working set / PSS), as CI runs it |
| `npm run e2e:build` then `npm run e2e` | Native end-to-end tests on the test build: the widget isolation probe on every OS, plus tauri-driver screen checks on Windows/Linux (see [e2e/README.md](e2e/README.md)) |
| `scripts/mac-native-check.sh` | macOS: window, app menu, close-to-tray and quit, captured window by window with `screencapture -l`, then the isolation probe |
| `scripts/screenshot-gallery.sh` | Turn local and CI screenshots into a markdown gallery for a PR body |

On macOS, local builds produce only the `.app`, and `src-tauri/tauri.macos.conf.json` makes that the default. Building a DMG opens Finder windows, so DMGs, and the Windows and Linux installers, are built in CI and attached to each run as artifacts.

The UI talks to the core only through `src/platform/`. When the UI runs in a plain browser, the adapter falls back to mocks. Colours are design tokens (`src/theme/`), and the default theme is rlx's own TUI palette.

### Budgets

| | Budget |
| --- | --- |
| Installer | ≤ 25 MB |
| Idle RAM | ≤ 150 MB |
| Cold start | ≤ 1.5 s on Apple silicon |

The header of `scripts/measure-budgets.sh` explains how each number is measured.

## Credits

The `r\x` mark is outlined from [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), © 2020 The JetBrains Mono Project Authors, under the SIL Open Font License 1.1.
