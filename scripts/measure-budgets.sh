#!/usr/bin/env bash
#
# measure-budgets.sh: measure rlx (the app built from this repo) against its size and speed budgets (macOS only).
#
# Usage:
#   scripts/measure-budgets.sh [--build] [--runs N] [--idle-runs N] [--idle-seconds S] [--purge] [--enforce]
#
#   --build           run `npm run tauri build -- --bundles app` first (default: measure the existing bundle)
#   --runs N          number of timed cold-start launches (default: 5)
#   --idle-runs N     number of idle-memory launches; the budget uses their median (default: 3)
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
#   The installer is the unsigned .dmg. DMGs are built only in CI, because building
#   one opens Finder windows. Local builds use `--bundles app`, so locally the
#   script reports:
#     - the .app bundle size (the sum of its file sizes);
#     - a compressed estimate: the size of `ditto -c -k --keepParent rlx.app` (a
#       zip). The DMG's zlib compression lands close to it.
#   When a rlx_*.dmg newer than the .app is present (the macOS CI job builds one
#   first), its byte size is reported too. The budget is then checked against the
#   DMG; otherwise it is checked against the zip estimate.
#
# Cold start: launch to first window paint
#   Every run starts with the app not running. The app is launched the way Finder
#   launches it, through LaunchServices:
#     open -n -F --env RLXAPP_STARTUP_PROBE=<file> rlx.app
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
# Idle RAM (the budget's measure, as decided for rlx: phys_footprint)
#   After the timed runs, the app is launched N more times (default 3). Each launch
#   is left idle with its default window open for S seconds past first paint. Under
#   the probe, app_info reports `measuring`, so the UI opens on Home (not onboarding)
#   with its default widgets and agents, and saves no settings. The
#   script then samples every process that belongs to the app:
#     - the app process itself;
#     - the WebKit XPC helpers that launchd started on its behalf:
#       com.apple.WebKit.WebContent, .Networking and .GPU, as listed by
#       `launchctl print pid/<app pid>`. They are not child processes by parent PID,
#       which is why launchd attributes them.
#   For each process it reads phys_footprint from footprint(1), which is the "Memory"
#   column in Activity Monitor and is what the 150 MB budget applies to. It also reads
#   the resident set size (`ps -o rss=`). RSS counts shared system framework pages
#   again in every process, so the RSS sum overstates memory; it is printed as a
#   secondary number. The budget is checked against the median of the N
#   phys_footprint totals.

set -euo pipefail

BUDGET_DMG_MB=25
BUDGET_COLD_MS=1500
BUDGET_RAM_MB=150

runs=5
idle_runs=3
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
    --idle-runs)
      [[ ${2:-} =~ ^[1-9][0-9]*$ ]] || die "--idle-runs needs a positive integer"
      idle_runs=$2
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

# Physical path (-P), so BIN matches the executable path that ps reports.
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"
APP="$BUNDLE_DIR/macos/rlx.app"

if ((do_build)); then
  (cd "$ROOT" && npm run tauri build -- --bundles app)
fi

[[ -f $APP/Contents/Info.plist ]] || die "no $APP; run 'npm run tauri build -- --bundles app' or pass --build"
BIN="$APP/Contents/MacOS/$(plutil -extract CFBundleExecutable raw "$APP/Contents/Info.plist")"
[[ -x $BIN ]] || die "no app binary at $BIN"

# A DMG counts only if it was built from this .app (CI builds both in one run).
DMG=""
for candidate in $(ls -t "$BUNDLE_DIR"/dmg/rlx_*.dmg 2>/dev/null || true); do
  [[ $candidate -nt $BIN ]] && DMG=$candidate
  break
done

WORK=$(mktemp -d -t rlxapp-budgets)

# PIDs of running instances of this exact binary. This is a plain string compare on
# ps's executable path: `pgrep -f` applies a regex to every process's arguments and
# fails on bytes that are invalid in the current locale.
app_pids() {
  ps -axo pid=,comm= | LC_ALL=C awk -v bin="$BIN" '{
    pid = $1
    sub(/^ *[0-9]+ /, "")
    if ($0 == bin) print pid
  }'
}

app_pid() {
  app_pids | head -n 1
}

quit_app() {
  local pid
  for pid in $(app_pids); do
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true
  done
}

cleanup() {
  quit_app
  rm -rf "$WORK"
}
trap cleanup EXIT

[[ -z $(app_pid) ]] || die "rlx is already running from $APP; quit it first"

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

# Reads numbers (one per line) on stdin; prints "<min> <median> <max>".
min_median_max() {
  sort -n | awk '
    { v[NR] = $1 }
    END {
      m = (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2
      printf "%s %s %s\n", v[1], m, v[NR]
    }'
}
verdict() { awk -v v="$1" -v max="$2" 'BEGIN { print (v <= max ? "OK" : "OVER") }'; }

over=0
note_verdict() { [[ $1 == OK ]] || over=1; }

echo "rlx budgets"
echo "  host:  $(sysctl -n machdep.cpu.brand_string), macOS $(sw_vers -productVersion) ($(uname -m))"
echo "  app:   ${APP#"$ROOT"/}"
echo

# 1. Installer size --------------------------------------------------------------
app_bytes=$(find "$APP" -type f -exec stat -f %z {} + | awk '{ s += $1 } END { print s + 0 }')
ditto -c -k --keepParent "$APP" "$WORK/rlx.zip"
zip_bytes=$(stat -f %z "$WORK/rlx.zip")
echo "installer:"
echo "  rlx.app bundle      $(mb "$app_bytes") MB ($app_bytes bytes)"
echo "  zip estimate        $(mb "$zip_bytes") MB ($zip_bytes bytes)"
if [[ -n $DMG ]]; then
  dmg_bytes=$(stat -f %z "$DMG")
  echo "  $(basename "$DMG")  $(mb "$dmg_bytes") MB ($dmg_bytes bytes)"
  installer_label="dmg"
  installer_mb=$(mb "$dmg_bytes")
else
  echo "  dmg                 not built locally (DMGs are CI-only; see the macOS CI job)"
  installer_label="zip est."
  installer_mb=$(mb "$zip_bytes")
fi
installer_verdict=$(verdict "$installer_mb" "$BUDGET_DMG_MB")
note_verdict "$installer_verdict"
echo

# rlx is single-instance: while any copy runs (e.g. /Applications/rlx.app), a new launch hands
# off to it and exits without painting. Never quit someone's running copy; say so and stop.
other_rlx=$(ps -axo pid=,comm= | LC_ALL=C awk -v bin="$BIN" '{
  pid = $1
  sub(/^ *[0-9]+ /, "")
  if ($0 ~ /\/rlx\.app\/Contents\/MacOS\/rlxapp$/ && $0 != bin) print pid " " $0
}')
if [[ -n $other_rlx ]]; then
  die "another rlx is running ($other_rlx). rlx is single-instance, so new launches would hand off to it. Quit it, then measure again."
fi

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
  [[ -z $(app_pid) ]] || die "run $i: the app did not quit"
  sleep 1 # let the WebKit helpers exit before the next launch
done
read -r cold_min cold_median cold_max < <(min_median_max <"$WORK/cold.txt")
cold_median=$(printf '%.0f' "$cold_median")
cold_verdict=$(verdict "$cold_median" "$BUDGET_COLD_MS")
note_verdict "$cold_verdict"
echo "  median $cold_median ms (min $cold_min, max $cold_max)"
echo

# 3. Idle RAM --------------------------------------------------------------------
echo "idle memory: $idle_runs run(s), sampled ${idle_seconds} s after first paint"
: >"$WORK/footprint.txt"
: >"$WORK/rss.txt"
for i in $(seq 1 "$idle_runs"); do
  launch "$WORK/probe-idle-$i.txt" "$WORK/t0-idle-$i.txt"
  wait_for_paint "$WORK/probe-idle-$i.txt" >/dev/null || die "idle run $i: no first paint within 30 s"
  sleep "$idle_seconds"
  pid=$(app_pid)
  [[ -n $pid ]] || die "idle run $i: app exited during the idle period"

  helpers=$(launchctl print "pid/$pid" | awk '
    /^\tservices = \{/ { inside = 1; next }
    inside && /^\t\}/ { inside = 0 }
    inside && $1 > 0 && $3 ~ /^com\.apple\.WebKit\./ { print $1 }')
  [[ -n $helpers ]] || die "idle run $i: no WebKit helper processes found for pid $pid"

  rss_total=0
  footprint_total=0
  ((i == 1)) && printf '  run 1 by process:\n    %-28s %15s %10s\n' process "footprint MB" "RSS MB"
  for p in $pid $helpers; do
    name=$(basename "$(ps -o comm= -p "$p")")
    rss=$(($(ps -o rss= -p "$p" | tr -d ' ') * 1024))
    fp=$(footprint --noCategories -f bytes "$p" 2>/dev/null | awk '/phys_footprint:/ { print $2; exit }' || true)
    [[ -n $fp ]] || die "idle run $i: footprint(1) could not read $name ($p)"
    rss_total=$((rss_total + rss))
    footprint_total=$((footprint_total + fp))
    ((i == 1)) && printf '    %-28s %15s %10s\n' "$name" "$(mb "$fp")" "$(mb "$rss")"
  done
  echo "$footprint_total" >>"$WORK/footprint.txt"
  echo "$rss_total" >>"$WORK/rss.txt"
  printf '  run %d: phys_footprint %7s MB   RSS %7s MB   (%d processes)\n' \
    "$i" "$(mb "$footprint_total")" "$(mb "$rss_total")" $((1 + $(wc -w <<<"$helpers")))
  quit_app
  [[ -z $(app_pid) ]] || die "idle run $i: the app did not quit"
  sleep 1
done
read -r _ fp_median _ < <(min_median_max <"$WORK/footprint.txt")
read -r _ rss_median _ < <(min_median_max <"$WORK/rss.txt")
ram_mb=$(mb "$fp_median")
ram_verdict=$(verdict "$ram_mb" "$BUDGET_RAM_MB")
note_verdict "$ram_verdict"
echo "  median phys_footprint $ram_mb MB (budget measure); median RSS $(mb "$rss_median") MB (secondary)"
echo

# Summary --------------------------------------------------------------------------
echo "summary"
printf '  %-12s %12s   budget %-10s %s\n' "installer" "$installer_mb MB" "<= $BUDGET_DMG_MB MB" "$installer_verdict ($installer_label)"
printf '  %-12s %12s   budget %-10s %s\n' "cold start" "$cold_median ms" "<= $BUDGET_COLD_MS ms" "$cold_verdict"
printf '  %-12s %12s   budget %-10s %s\n' "idle RAM" "$ram_mb MB" "<= $BUDGET_RAM_MB MB" "$ram_verdict (phys_footprint)"

if ((enforce && over)); then
  exit 1
fi
