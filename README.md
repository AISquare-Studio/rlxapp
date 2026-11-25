# rlxapp

A desktop app that runs [rlx](https://github.com/AISquare-Studio/rlx) agents in the background, with a friendly face for people who don't live in a terminal.

Coming soon.

## Development

rlxapp is a [Tauri 2](https://v2.tauri.app) app. The Rust core lives in `src-tauri/` and the React + TypeScript UI, built with Vite, lives in `src/`.

### Prerequisites

- Node.js 24 or newer; `.nvmrc` pins the version CI uses. npm comes with Node.
- Rust through [rustup](https://rustup.rs). `rust-toolchain.toml` pins the version, and rustup installs it on first use.
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
| `npm run tauri build` | Build an unsigned release bundle (`.app`/`.dmg`, `.msi`/`.exe`, `.deb`/`.rpm`/`.AppImage`) into `src-tauri/target/release/bundle/` |
| `npm run lint` / `npm run typecheck` / `npm test` | Lint (oxlint), typecheck (tsc) and test (Vitest) the UI |
| `cargo test` / `cargo clippy --all-targets -- -D warnings` | Test and lint the core (run in `src-tauri/`) |
| `npm run smoke -- <binary>` | Launch a built binary and check that it paints and stays up for 5 s |
| `scripts/measure-budgets.sh` | macOS: installer size, cold start and idle memory against the budgets |

The UI talks to the core only through `src/platform/`. When the UI runs in a plain browser, the adapter falls back to mocks.

### Budgets

| | Budget |
| --- | --- |
| Installer | ≤ 25 MB |
| Idle RAM | ≤ 150 MB |
| Cold start | ≤ 1.5 s on Apple silicon |

The header of `scripts/measure-budgets.sh` explains how each number is measured.
