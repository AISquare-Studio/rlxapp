#!/usr/bin/env bash
# macOS native checks of the built rlx app: window, second launch, app menu, no tray or
# login item, close, reopen and quit.
#
#   scripts/mac-native-check.sh [--no-build] [--install] [--no-probe] [--skip CHECK]...
#
# macOS has no WebDriver for WKWebView, so this drives the real app with osascript and
# captures ONLY the app's own windows with `screencapture -l <windowid>`. It never takes a
# full-screen capture and never builds a DMG (building one opens Finder windows).
#
# What it does:
#   1. builds the app: `npm run tauri build -- --bundles app` (skip with --no-build). With
#      --install it then copies rlx.app to /Applications/rlx.app, replacing it.
#   2. launches it with `open` (LaunchServices), finds the main window's id (CGWindowList, by
#      the app's pid), checks its title and shoots it;
#   3. launches it again: the existing process must take it and show its window, with no
#      second process;
#   4. opens the app menu with osascript and shoots the menu's own window;
#   5. checks the app has no menu-bar (tray) item and no login item. The tray belongs to the
#      rlx service, not the app;
#   6. closes the main window: the process stays up with no window on screen. Then reopens it
#      with `open` (as a Dock click does): the window comes back;
#   7. quits through the app menu (rlx → Quit rlx) and checks that the process exits;
#   8. runs the widget isolation probe on a test build (`npm run e2e:build`, then
#      e2e/native/probe.mjs). Skip it with --no-probe.
#
# Checks: window, second-launch, menu, no-tray, no-login-item, close, reopen, quit, probe.
# `--skip CHECK` turns one into a SKIP line, for a build that lacks a behaviour so far. Any
# FAIL exits non-zero.
#
# Screenshots: e2e/screenshots/macos-native--<shot>.png. scripts/screenshot-gallery.sh turns them into a
# PR gallery.
#
# Permissions. The app that runs this shell (usually your terminal) needs:
#   - Screen Recording, for `screencapture -l`;
#   - Accessibility, and Automation of "System Events", to open menus and close the window.
# The script checks these first, without prompting, and stops with the exact setting to
# change, rather than hanging on a prompt or capturing a blank window.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
SHOTS="$ROOT/e2e/screenshots"
APP_BUNDLE="$ROOT/src-tauri/target/release/bundle/macos/rlx.app"
JXA="$ROOT/scripts/lib/mac-windows.js"

build=1
install=0
probe=1
skips=" "
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) build=0 ;;
    --install) install=1 ;;
    --no-probe) probe=0 ;;
    --skip) skips+="$2 "; shift ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

if [[ "$(uname -s)" != Darwin ]]; then
  echo "mac-native-check: macOS only. Windows and Linux run 'npm run e2e' under tauri-driver." >&2
  exit 2
fi

failures=0
pass() { printf 'PASS  %s: %s\n' "$1" "$2"; }
fail() { printf 'FAIL  %s: %s\n' "$1" "$2"; failures=$((failures + 1)); }
info() { printf 'info  %s\n' "$*"; }
skipped() { [[ "$skips" == *" $1 "* ]] && { printf 'SKIP  %s (--skip %s)\n' "$1" "$1"; return 0; }; return 1; }

# Runs a command with a time limit, so a permission prompt or a stuck menu can't hang the run.
with_timeout() {
  local seconds=$1; shift
  "$@" &
  local pid=$!
  ( sleep "$seconds"; kill "$pid" 2>/dev/null ) &
  local watchdog=$!
  local status=0
  wait "$pid" || status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return "$status"
}

json_get() { node -e 'const v = JSON.parse(process.argv[1]); const k = process.argv[2]; console.log(v[k]);' "$1" "$2"; }

# --- 0. Permissions -------------------------------------------------------------------
preflight=$(osascript -l JavaScript "$JXA" preflight $$)
responsible_pid=$(json_get "$preflight" responsiblePid)
responsible=$(ps -o comm= -p "$responsible_pid" 2>/dev/null || true)
terminal_app=${responsible%%.app/*}
if [[ "$terminal_app" != "$responsible" ]]; then terminal_app="$terminal_app.app"; fi
terminal_name=$(basename "${terminal_app:-your terminal}" .app)

missing=()
if [[ "$(json_get "$preflight" screenRecording)" != true ]]; then
  missing+=("Screen Recording: System Settings > Privacy & Security > Screen & System Audio Recording > turn on $terminal_name")
fi
if [[ "$(json_get "$preflight" accessibility)" != true ]]; then
  missing+=("Accessibility: System Settings > Privacy & Security > Accessibility > turn on $terminal_name")
fi
if ! with_timeout 10 osascript -e 'tell application "System Events" to count processes' >/dev/null 2>&1; then
  missing+=("Automation: System Settings > Privacy & Security > Automation > $terminal_name > turn on System Events")
fi
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "mac-native-check: macOS hasn't granted the permissions these checks need to $terminal_name" >&2
  echo "(${terminal_app:-pid $responsible_pid}, the app this shell runs under):" >&2
  for line in "${missing[@]}"; do echo "  - grant $line" >&2; done
  echo "Then quit and reopen $terminal_name, and run this again. Nothing was captured." >&2
  echo "(The widget isolation probe needs none of these: npm run e2e:build && npm run e2e.)" >&2
  exit 3
fi
pass permissions "Screen Recording, Accessibility and System Events granted to $terminal_name"

# --- 1. Build ---------------------------------------------------------------------------
if [[ $build -eq 1 ]]; then
  echo "mac-native-check: building rlx.app (npm run tauri build -- --bundles app)"
  npm run tauri build -- --bundles app
fi
[[ -d "$APP_BUNDLE" ]] || { echo "no app at $APP_BUNDLE; drop --no-build" >&2; exit 2; }
if [[ $install -eq 1 ]]; then
  rm -rf /Applications/rlx.app
  cp -R "$APP_BUNDLE" /Applications/rlx.app
  APP_BUNDLE=/Applications/rlx.app
  info "installed to /Applications/rlx.app"
fi
mkdir -p "$SHOTS"

# --- 2. Launch and shoot the main window ----------------------------------------------
EXE="$APP_BUNDLE/Contents/MacOS/rlxapp"
app_pids() { pgrep -f "^$EXE" || true; }
if [[ -n "$(app_pids)" ]]; then
  echo "mac-native-check: rlx from $APP_BUNDLE is already running; quit it first." >&2
  exit 2
fi
open "$APP_BUNDLE"
APP_PID=""
for _ in $(seq 1 40); do
  APP_PID=$(app_pids | head -1)
  [[ -n "$APP_PID" ]] && break
  sleep 0.25
done
[[ -n "$APP_PID" ]] || { echo "mac-native-check: rlx didn't start" >&2; exit 1; }
cleanup() { for pid in $(app_pids); do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT
SE_PROCESS="first process whose unix id is $APP_PID"

windows() { osascript -l JavaScript "$JXA" windows "$APP_PID"; }
# The id of the largest on-screen window at a layer test, e.g. '== 0'.
window_id() {
  windows | node -e '
    const test = new Function("layer", `return layer ${process.argv[1]}`);
    const ws = JSON.parse(require("fs").readFileSync(0, "utf8")).filter((w) => w.onScreen && test(w.layer));
    ws.sort((a, b) => b.width * b.height - a.width * a.height);
    console.log(ws.length ? ws[0].id : "");' "$1"
}
wait_window() { # wait_window <seconds>: the main window's id once it is on screen
  local id=""
  for _ in $(seq 1 $(( $1 * 4 ))); do
    id=$(window_id '== 0')
    [[ -n "$id" ]] && break
    kill -0 "$APP_PID" 2>/dev/null || break
    sleep 0.25
  done
  echo "$id"
}
shoot() { # shoot <window id> <name>
  local file="$SHOTS/macos-native--$2.png"
  if with_timeout 15 screencapture -l "$1" -o -x "$file" && [[ -s "$file" ]]; then
    info "captured window $1 → e2e/screenshots/macos-native--$2.png"
  else
    fail "$2" "screencapture -l $1 produced no image"
    return 1
  fi
}
se() { with_timeout 10 osascript -e "tell application \"System Events\" to $1" 2>/dev/null; }

main_id=$(wait_window 30)
layer0=$(windows | node -e 'const ws = JSON.parse(require("fs").readFileSync(0, "utf8")).filter((w) => w.layer === 0); console.log(ws.map((w) => `${w.id} ${w.width}x${w.height}${w.onScreen ? "" : " (off screen)"}`).join(", "))')
info "the app's layer-0 windows: $layer0"
if ! skipped window; then
  title=$(se "get name of window 1 of ($SE_PROCESS)" || true)
  if [[ -z "$main_id" ]]; then
    fail window "no on-screen window for pid $APP_PID"
  elif [[ "$title" != rlx ]]; then
    fail window "the main window's title is '$title', not 'rlx'"
  elif shoot "$main_id" main-window; then
    pass window "window $main_id, title 'rlx'"
  fi
fi

# --- 3. A second launch goes to the running app -----------------------------------------
if ! skipped second-launch; then
  open "$APP_BUNDLE"
  sleep 2
  count=$(app_pids | wc -l | tr -d ' ')
  front=$(se "get frontmost of ($SE_PROCESS)" || true)
  if [[ "$count" != 1 ]]; then
    fail second-launch "$count rlx processes after a second launch"
  elif [[ -z "$(window_id '== 0')" || "$front" != true ]]; then
    fail second-launch "the running app didn't come forward with its window (frontmost: ${front:-unknown})"
  else
    pass second-launch "one process; its window is on screen and frontmost"
  fi
fi

# --- 4. The app menu ---------------------------------------------------------------------
if ! skipped menu; then
  se "set frontmost of ($SE_PROCESS) to true" >/dev/null || true
  sleep 0.5
  # Clicking a menu-bar item blocks osascript until the menu closes, so click in the
  # background, shoot the menu's window, then close it with Escape.
  with_timeout 20 osascript -e "tell application \"System Events\" to tell ($SE_PROCESS) to click menu bar item 2 of menu bar 1" >/dev/null 2>&1 &
  clicker=$!
  menu_id=""
  for _ in $(seq 1 20); do
    sleep 0.25
    menu_id=$(window_id '> 0')
    [[ -n "$menu_id" ]] && break
  done
  items=$(se "tell ($SE_PROCESS) to get name of menu items of menu 1 of menu bar item 2 of menu bar 1" || true)
  if [[ -z "$menu_id" ]]; then
    fail menu "the app menu didn't open (no menu window for pid $APP_PID)"
  elif [[ "$items" != *"Quit rlx"* ]]; then
    shoot "$menu_id" app-menu || true
    fail menu "the app menu has no 'Quit rlx' item: $items"
  elif shoot "$menu_id" app-menu; then
    pass menu "window $menu_id; items: $items"
  fi
  with_timeout 5 osascript -e 'tell application "System Events" to key code 53' >/dev/null 2>&1 || true
  wait "$clicker" 2>/dev/null || true
fi

# --- 5. No tray item, no login item ------------------------------------------------------
# The tray belongs to the rlx service (rlxd), not the app.
if ! skipped no-tray; then
  status_id=$(window_id '== 25')
  extras=$(se "tell ($SE_PROCESS) to count menu bar items of menu bar 2" || echo 0)
  if [[ -n "$status_id" || "${extras:-0}" -gt 0 ]]; then
    if [[ -n "$status_id" ]]; then shoot "$status_id" unexpected-menu-bar-item || true; fi
    fail no-tray "the app put an item in the menu bar (window ${status_id:-none}, $extras through System Events)"
  else
    pass no-tray "no status-item window and no menu-bar extra"
  fi
fi
if ! skipped no-login-item; then
  login_items=$(se "get the name of every login item" || true)
  agents=$(ls "$HOME/Library/LaunchAgents" 2>/dev/null | grep -i 'studio\.aisquare\.rlx' || true)
  if [[ ",${login_items// /}," == *",rlx,"* || -n "$agents" ]]; then
    fail no-login-item "found a login item (${login_items:-none}) or launch agent (${agents:-none})"
  else
    pass no-login-item "no rlx login item and no studio.aisquare.rlx launch agent"
  fi
fi

# --- 6. Close the window, then reopen it ------------------------------------------------
if ! skipped close; then
  se "tell ($SE_PROCESS) to click (first button of window 1 whose subrole is \"AXCloseButton\")" >/dev/null || true
  sleep 2
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    fail close "closing the window quit the app"
  elif [[ -n "$(window_id '== 0')" ]]; then
    fail close "the main window is still on screen after Close"
  else
    pass close "process $APP_PID up with no window on screen"
  fi
fi
if ! skipped reopen; then
  if kill -0 "$APP_PID" 2>/dev/null; then
    open "$APP_BUNDLE"
    reopened=$(wait_window 10)
    if [[ -n "$reopened" && "$(app_pids | wc -l | tr -d ' ')" == 1 ]]; then
      pass reopen "window $reopened back on screen, same process"
    else
      fail reopen "no window after reopening the running app"
    fi
  else
    fail reopen "the app was gone before Reopen"
  fi
fi

# --- 7. Quit through the app menu ------------------------------------------------------
if ! skipped quit; then
  if kill -0 "$APP_PID" 2>/dev/null; then
    se "set frontmost of ($SE_PROCESS) to true" >/dev/null || true
    se "tell ($SE_PROCESS) to click menu item \"Quit rlx\" of menu 1 of menu bar item 2 of menu bar 1" >/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.25; done
    if kill -0 "$APP_PID" 2>/dev/null; then
      fail quit "rlx → Quit rlx didn't end the process"
    else
      pass quit "the process exited"
    fi
  else
    fail quit "the app was already gone before Quit"
  fi
fi
cleanup

# --- 8. The widget isolation probe ----------------------------------------------------
if [[ $probe -eq 1 ]] && ! skipped probe; then
  npm run e2e:build
  if node e2e/native/probe.mjs; then
    pass probe "e2e/results/isolation-probe-macos.md"
  else
    fail probe "see e2e/results/isolation-probe-macos.md"
  fi
fi

if [[ $failures -gt 0 ]]; then
  echo "mac-native-check: FAIL ($failures)"
  exit 1
fi
echo "mac-native-check: PASS (screenshots in e2e/screenshots/)"
