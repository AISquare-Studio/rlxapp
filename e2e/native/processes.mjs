// Process clean-up between app launches.
//
// On Windows, the app's WebView2 runs in child msedgewebview2.exe processes that share the
// app's user-data folder. Killing only the app can leave them running, and the next launch
// then joins the old browser process and ignores its new arguments. That is how msedgedriver
// fails with "DevToolsActivePort file doesn't exist". So on Windows the whole tree is
// stopped, and the next launch waits until no WebView2 process is left.
import { execFileSync } from "node:child_process";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Stops `child` and, on Windows, every process it started. */
export async function stopTree(child, isExited) {
  if (isExited()) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
  } else {
    child.kill();
  }
  const deadline = Date.now() + 5000;
  while (!isExited() && Date.now() < deadline) await sleep(100);
  if (!isExited()) child.kill("SIGKILL");
}

/** The WebView2 processes still running (Windows only; elsewhere none). */
export function webviewProcesses() {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq msedgewebview2.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
    return out.split(/\r?\n/).filter((line) => line.toLowerCase().includes("msedgewebview2"));
  } catch {
    return [];
  }
}

/** Waits up to `ms` for every WebView2 process to exit; returns those still running. */
export async function waitForWebviewsToExit(ms = 15_000) {
  const deadline = Date.now() + ms;
  let left = webviewProcesses();
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(250);
    left = webviewProcesses();
  }
  return left;
}
