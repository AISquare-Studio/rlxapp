// A small W3C WebDriver client for tauri-driver, plus the tauri-driver launcher.
//
// tauri-driver forwards to the platform's native driver: msedgedriver for WebView2 on
// Windows, WebKitWebDriver for WebKitGTK on Linux. macOS has no WebDriver for WKWebView, so
// there scripts/mac-native-check.sh drives the app instead. The client speaks plain W3C
// classic over fetch, with no dependencies and no BiDi negotiation for tauri-driver to refuse.
import { spawn } from "node:child_process";

const ELEMENT = "element-6066-11e4-a23d-4a4d4fd4a3d1";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function request(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path}: HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const value = json.value;
  if (!response.ok || (value && typeof value === "object" && "error" in value)) {
    throw new Error(`${method} ${path}: ${value?.error ?? response.status}: ${value?.message ?? text.slice(0, 300)}`);
  }
  return value;
}

/** Starts tauri-driver on `port` and resolves once it answers /status. */
export async function startTauriDriver({ port = 4444, nativeDriver, env = process.env, log = console.log } = {}) {
  const args = ["--port", String(port)];
  if (nativeDriver) args.push("--native-driver", nativeDriver);
  log(`webdriver: starting tauri-driver ${args.join(" ")}`);
  const child = spawn("tauri-driver", args, { env, stdio: ["ignore", "inherit", "inherit"] });
  let failed = null;
  child.on("error", (error) => (failed = error));
  child.on("exit", (code) => (failed ??= new Error(`tauri-driver exited with code ${code}`)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (failed) throw new Error(`tauri-driver: ${failed.message}. Install it with \`cargo install tauri-driver --locked\`.`);
    try {
      await request(base, "GET", "/status");
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("tauri-driver didn't answer /status within 30 s");
      await sleep(250);
    }
  }
  return {
    base,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill();
      await Promise.race([new Promise((done) => child.once("exit", done)), sleep(5000)]);
    },
  };
}

export class Session {
  /** Opens a session that launches `application` (the built binary) under tauri-driver. */
  static async create(base, application) {
    const value = await request(base, "POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application } } },
    });
    return new Session(base, value.sessionId);
  }

  constructor(base, id) {
    this.base = base;
    this.id = id;
  }

  #call(method, path, body) {
    return request(this.base, method, `/session/${this.id}${path}`, body);
  }

  /** The document title. */
  title() {
    return this.#call("GET", "/title");
  }

  /** Runs `script` (a function body; `arguments` are `args`) and returns its value. */
  execute(script, args = []) {
    return this.#call("POST", "/execute/sync", { script, args });
  }

  /** Like execute, but the script calls `arguments[arguments.length - 1](value)` to finish. */
  executeAsync(script, args = []) {
    return this.#call("POST", "/execute/async", { script, args });
  }

  /** Awaits a promise-returning expression in the page, e.g. a Tauri invoke(). */
  async evaluate(expression) {
    const result = await this.executeAsync(
      `const done = arguments[arguments.length - 1];
       Promise.resolve().then(() => (${expression})).then(
         (value) => done({ ok: true, value }),
         (error) => done({ ok: false, error: String(error && error.message || error) }));`,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  /** The first element matching `css`, or null. */
  async find(css) {
    const found = await this.#call("POST", "/elements", { using: "css selector", value: css });
    return found.length > 0 ? found[0] : null;
  }

  /** Waits up to `ms` for an element matching `css`. */
  async waitFor(css, ms = 15_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const element = await this.find(css);
      if (element) return element;
      if (Date.now() > deadline) throw new Error(`no element matches ${css} after ${ms / 1000} s`);
      await sleep(200);
    }
  }

  /** A PNG of the viewport. */
  async screenshot() {
    return Buffer.from(await this.#call("GET", "/screenshot"), "base64");
  }

  /** A PNG of one element. */
  async elementScreenshot(element) {
    return Buffer.from(await this.#call("GET", `/element/${element[ELEMENT]}/screenshot`), "base64");
  }

  async delete() {
    try {
      await this.#call("DELETE", "");
    } catch {
      // already gone
    }
  }
}
