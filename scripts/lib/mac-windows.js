// JXA helper for scripts/mac-native-check.sh. Needs no permissions to run.
//
//   osascript -l JavaScript scripts/lib/mac-windows.js preflight <shell-pid>
//     → { screenRecording, accessibility, responsiblePid }
//       screenRecording: CGPreflightScreenCaptureAccess(), which never prompts;
//       accessibility: AXIsProcessTrusted(), which never prompts;
//       responsiblePid: the process macOS's privacy settings (TCC) attribute <shell-pid> to,
//       usually the terminal app, which is the one to grant.
//   osascript -l JavaScript scripts/lib/mac-windows.js windows <pid>
//     → [{ id, layer, name, x, y, width, height, onScreen }] for every window <pid> owns.
//       Window names need Screen Recording; ids, layers and bounds don't.
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");

// osascript calls run(argv) itself; nothing in this file does.
// eslint-disable-next-line no-unused-vars
function run(argv) {
  const [command, pidText] = argv;
  const pid = Number(pidText);
  if (command === "preflight") {
    ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
    ObjC.bindFunction("AXIsProcessTrusted", ["bool", []]);
    ObjC.bindFunction("responsibility_get_pid_responsible_for_pid", ["int", ["int"]]);
    return JSON.stringify({
      screenRecording: $.CGPreflightScreenCaptureAccess(),
      accessibility: $.AXIsProcessTrusted(),
      responsiblePid: pid > 0 ? $.responsibility_get_pid_responsible_for_pid(pid) : -1,
    });
  }
  if (command === "windows") {
    const all = ObjC.deepUnwrap(
      ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID)),
    );
    return JSON.stringify(
      all
        .filter((w) => w.kCGWindowOwnerPID === pid)
        .map((w) => ({
          id: w.kCGWindowNumber,
          layer: w.kCGWindowLayer,
          name: w.kCGWindowName ?? null,
          x: w.kCGWindowBounds.X,
          y: w.kCGWindowBounds.Y,
          width: w.kCGWindowBounds.Width,
          height: w.kCGWindowBounds.Height,
          onScreen: Boolean(w.kCGWindowIsOnscreen),
        })),
    );
  }
  throw new Error(`unknown command ${command}`);
}
