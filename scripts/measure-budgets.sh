#!/usr/bin/env bash
#
# measure-budgets.sh: measure rlxapp against its size and speed budgets (macOS only).
#
# Usage:
#   scripts/measure-budgets.sh [--build] [--runs N] [--idle-seconds S] [--purge] [--enforce]
#
#   --build           run `npm run tauri build` first (default: measure the existing bundle)
#   --runs N          number of timed cold-start launches (default: 5)
#   --idle-seconds S  idle time after first paint before memory is sampled (default: 30)
#   --purge           run `sudo purge` before every launch to drop the file cache (prompts for a password)
#   --enforce         exit 1 if any budget is exceeded (default: report only)
#
# Budgets (Apple silicon): installer <= 25 MB, cold start <= 1500 ms, idle RAM <= 150 MB.
# MB means 10^6 bytes throughout, the stricter reading of the budgets.
#
# Method
# ------
# Installer size
#   Byte size of the newest src-tauri/target/release/bundle/dmg/*.dmg, the unsigned
#   installer that `npm run tauri build` produces.
#
# Cold start: launch to first window paint
#   Every run starts with the app not running. The app is launched the way Finder
#   launches it, through LaunchServices:
#     open -n -F --env RLXAPP_STARTUP_PROBE=<file> rlxapp.app
#   t0 is the wall-clock time that perl records immediately before it execs `open`.
#   The web UI waits for the browser's First Contentful Paint entry, which is the first
#   frame showing the placeholder screen. It converts that entry to wall-clock time
#   with performance.timeOrigin + startTime and sends it to the Rust core. The core
#   appends it to the probe file; see src/platform/firstPaint.ts and
#   src-tauri/src/probe.rs. Cold start is first paint minus t0, which covers
#   LaunchServices, process start, Tauri/WebKit setup, page load and React's first
#   render. WebKit rounds paint timestamps to 1 ms.
#   Without --purge, the OS file cache stays warm after run 1. Run 1 is therefore the
#   closest to a cold boot, and later runs show the typical relaunch. The budget is
#   checked against the median of all runs.
#
# Idle RSS
#   After the timed runs, one more launch is left idle for S seconds past its first
#   paint. The script then adds up the resident set size (`ps -o rss=`) of the app
#   process and of the WebKit XPC helpers that launchd started on the app's behalf:
#   com.apple.WebKit.WebContent, .Networking and .GPU, as listed by
#   `launchctl print pid/<app pid>`. These helpers are not child processes by
#   parent PID, which is why launchd attributes them. RSS counts shared system
#   framework pages again in every process, so the sum overstates private memory.
#   For context, the script also prints the phys_footprint total from footprint(1),
#   which is the "Memory" figure in Activity Monitor.

set -euo pipefail

BUDGET_DMG_MB=25
BUDGET_COLD_MS=1500
BUDGET_RSS_MB=150

runs=5
idle_seconds=30
do_build=0
do_purge=0
enforce=0

die() {
  echo "measure-budgets: $*" >&2
  exit 2
}

usage() {
  sed -n '2,/^$/s/^# \{0,1\}//p' "$0"
  exit "${1:-0}"
}

while (($#)); do
  case "$1" in
    --build) do_build=1 ;;
    --purge) do_purge=1 ;;
    --enforce) enforce=1 ;;
    --runs)
      [[ ${2:-} =~ ^[1-9][0-9]*$ ]] || die "--runs needs a positive integer"
      runs=$2
      shift
      ;;
    --idle-seconds)
      [[ ${2:-} =~ ^[0-9]+$ ]] || die "--idle-seconds needs a non-negative integer"
      idle_seconds=$2
      shift
      ;;
    -h | --help) usage 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

[[ $(uname -s) == Darwin ]] || die "macOS only"

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"
APP="$BUNDLE_DIR/macos/rlxapp.app"
BIN="$APP/Contents/MacOS/rlxapp"

if ((do_build)); then
  (cd "$ROOT" && npm run tauri build)
fi

DMG=$(ls -t "$BUNDLE_DIR"/dmg/*.dmg 2>/dev/null | head -n 1 || true)
[[ -n $DMG ]] || die "no .dmg in $BUNDLE_DIR/dmg; run 'npm run tauri build' or pass --build"
[[ -x $BIN ]] || die "no app binary at $BIN; run 'npm run tauri build' or pass --build"

WORK=$(mktemp -d -t rlxapp-budgets)

app_pid() {
  pgrep -f "^$BIN" | head -n 1 || true
}

quit_app() {
  local pid
  pid=$(app_pid)
  [[ -n $pid ]] || return 0
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 100); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  quit_app
  rm -rf "$WORK"
}
trap cleanup EXIT

[[ -z $(app_pid) ]] || die "rlxapp is already running from $APP; quit it first"

# Launches the app through LaunchServices with the startup probe enabled.
# Writes the launch wall-clock time (epoch ms) to $2.
launch() {
  local probe=$1 t0_file=$2
  ((do_purge)) && sudo purge
  perl -MTime::HiRes=time -e '
    my $out = shift;
    open(my $fh, ">", $out) or die "t0: $!";
    printf $fh "%.3f\n", time() * 1000;
    close $fh;
    exec @ARGV or die "exec open: $!";
  ' "$t0_file" open -n -F --env "RLXAPP_STARTUP_PROBE=$probe" "$APP"
}

# Waits up to 30 s for the first-paint line; prints "<epoch_ms> <source>".
wait_for_paint() {
  local probe=$1 line deadline=$((SECONDS + 30))
  while ((SECONDS < deadline)); do
    if line=$(grep -m 1 '^first_paint ' "$probe" 2>/dev/null); then
      sed -E 's/^first_paint epoch_ms=([0-9.]+) source=([a-z]+)$/\1 \2/' <<<"$line"
      return 0
    fi
    sleep 0.02
  done
  return 1
}

mb() { awk -v b="$1" 'BEGIN { printf "%.2f", b / 1e6 }'; }
verdict() { awk -v v="$1" -v max="$2" 'BEGIN { print (v <= max ? "OK" : "OVER") }'; }

over=0
note_verdict() { [[ $1 == OK ]] || over=1; }

echo "rlxapp budgets"
echo "  host:  $(sysctl -n machdep.cpu.brand_string), macOS $(sw_vers -productVersion) ($(uname -m))"
echo "  app:   ${APP#"$ROOT"/}"
echo

# 1. Installer size --------------------------------------------------------------
dmg_bytes=$(stat -f %z "$DMG")
dmg_mb=$(mb "$dmg_bytes")
dmg_verdict=$(verdict "$dmg_mb" "$BUDGET_DMG_MB")
note_verdict "$dmg_verdict"
echo "installer: $(basename "$DMG") = $dmg_mb MB ($dmg_bytes bytes)"
echo

# 2. Cold start ------------------------------------------------------------------
echo "cold start: launch -> first contentful paint, $runs run(s)$( ((do_purge)) && echo ', file cache purged before each')"
: >"$WORK/cold.txt"
for i in $(seq 1 "$runs"); do
  launch "$WORK/probe-$i.txt" "$WORK/t0-$i.txt"
  read -r paint source < <(wait_for_paint "$WORK/probe-$i.txt") || die "run $i: no first paint within 30 s"
  t0=$(<"$WORK/t0-$i.txt")
  ms=$(awk -v p="$paint" -v t="$t0" 'BEGIN { printf "%.0f", p - t }')
  echo "$ms" >>"$WORK/cold.txt"
  printf '  run %d: %5d ms  (%s)\n' "$i" "$ms" "$source"
  quit_app
  sleep 1 # let the WebKit helpers exit before the next launch
done
read -r cold_min cold_median cold_max < <(sort -n "$WORK/cold.txt" | awk '
  { v[NR] = $1 }
  END {
    m = (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2
    printf "%d %.0f %d\n", v[1], m, v[NR]
  }')
cold_verdict=$(verdict "$cold_median" "$BUDGET_COLD_MS")
note_verdict "$cold_verdict"
echo "  median $cold_median ms (min $cold_min, max $cold_max)"
echo

# 3. Idle RSS --------------------------------------------------------------------
echo "idle memory: ${idle_seconds} s after first paint"
launch "$WORK/probe-idle.txt" "$WORK/t0-idle.txt"
wait_for_paint "$WORK/probe-idle.txt" >/dev/null || die "idle run: no first paint within 30 s"
sleep "$idle_seconds"
pid=$(app_pid)
[[ -n $pid ]] || die "idle run: app exited during the idle period"

helpers=$(launchctl print "pid/$pid" | awk '
  /^\tservices = \{/ { inside = 1; next }
  inside && /^\t\}/ { inside = 0 }
  inside && $1 > 0 && $3 ~ /^com\.apple\.WebKit\./ { print $1 }')
[[ -n $helpers ]] || die "idle run: no WebKit helper processes found for pid $pid"

rss_total_kb=0
footprint_total=0
printf '  %-28s %7s %10s %15s\n' process pid "RSS MB" "footprint MB"
for p in $pid $helpers; do
  name=$(basename "$(ps -o comm= -p "$p")")
  rss_kb=$(ps -o rss= -p "$p" | tr -d ' ')
  fp=$(footprint --noCategories -f bytes "$p" 2>/dev/null |
    awk '/phys_footprint:/ { print $2; exit }' || true)
  rss_total_kb=$((rss_total_kb + rss_kb))
  if [[ -n $fp ]]; then
    footprint_total=$((footprint_total + fp))
    fp_mb=$(mb "$fp")
  else
    fp_mb="n/a"
  fi
  printf '  %-28s %7s %10s %15s\n' "$name" "$p" "$(mb $((rss_kb * 1024)))" "$fp_mb"
done
rss_mb=$(mb $((rss_total_kb * 1024)))
rss_verdict=$(verdict "$rss_mb" "$BUDGET_RSS_MB")
note_verdict "$rss_verdict"
echo "  total RSS $rss_mb MB; total phys_footprint $(mb "$footprint_total") MB"
quit_app
echo

# Summary --------------------------------------------------------------------------
echo "summary"
printf '  %-12s %12s   budget %-10s %s\n' installer "$dmg_mb MB" "<= $BUDGET_DMG_MB MB" "$dmg_verdict"
printf '  %-12s %12s   budget %-10s %s\n' "cold start" "$cold_median ms" "<= $BUDGET_COLD_MS ms" "$cold_verdict"
printf '  %-12s %12s   budget %-10s %s\n' "idle RSS" "$rss_mb MB" "<= $BUDGET_RSS_MB MB" "$rss_verdict"

if ((enforce && over)); then
  exit 1
fi
