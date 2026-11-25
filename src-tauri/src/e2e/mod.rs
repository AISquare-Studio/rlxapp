//! The widget isolation probe (docs/architecture.md §5.3). Test builds only: `--features e2e`.
//!
//! Launch the test build with `RLXAPP_E2E_REPORT=<file>` and the app checks, from inside
//! itself, what a widget can reach. It then writes a JSON report to that file, which
//! `e2e/native/probe.mjs` judges. Without the variable, the test build acts like the product
//! plus one extra command (the canary).
//!
//! What runs:
//! 1. Three local listeners on 127.0.0.1, each TCP and UDP on one port: `host` and `iframe`
//!    are the targets of every connection attempt from the host page and from the widget
//!    iframe; `control` is for the main webview's control run. Each passes a self-test first.
//! 2. The per-OS switch, through the product API: an agent-made widget must be refused while
//!    the switch is off, and on Linux nothing registers and no widget webview attaches.
//! 3. Where the OS has a widget webview (macOS, Windows), the `widgets` child webview is
//!    attached exactly as the product does it (`widget_host::attach`). The core mounts:
//!    - the probe fixture, standing in for an agent-made widget;
//!    - a built-in control widget;
//!    - the refused agent-made widget's URL.
//!
//!    `probe-host.js` probes from the host page, and `probe-widget.html` from inside the
//!    widget iframe.
//! 4. In main: a control call of the canary, which must be recorded, and an iframe that
//!    main's CSP must block.
//!
//! The canary command `e2e_canary` is granted to the main webview only, by a runtime
//! capability below. Any call recorded from another webview means a widget ran a command.

mod listener;

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, Runtime, Webview};

use crate::widget_host::{self, Bounds, HostExtras, PolicyInfo, Registry, Source};
use listener::Listener;

/// Names the file the report is written to. Unset, the probe doesn't run.
pub const ENV_REPORT: &str = "RLXAPP_E2E_REPORT";

/// Tauri exempts its channel fetch from the ACL (it reads only the caller's own queue), so
/// the probe calls and records it but asserts nothing about it.
pub const CHANNEL_FETCH: &str = "plugin:__TAURI_CHANNEL__|fetch";

const ACL_MANIFESTS: &str = include_str!("../../gen/schemas/acl-manifests.json");
const PROBE_HOST_JS: &str = include_str!("probe-host.js");
const PROBE_WIDGET_HTML: &str = include_str!("probe-widget.html");
const MAIN_CONTROL_JS: &str = include_str!("main-control.js");

const FIXTURE_ID: &str = "e2e-probe";
const BUILTIN_ID: &str = "e2e-builtin";
const AGENT_ID: &str = "e2e-agent";

/// A widget that announces it ran, through the SDK and to its parent. As a built-in it is the
/// positive control for mounting and for the action route. As an agent-made widget it must
/// never run while the switch is off.
fn announcing_widget(id: &str) -> String {
    format!(
        "<p>{id}</p><script>parent.postMessage({{type:'e2e-ran',id:'{id}'}},'*');\
         rlx.on(function(m){{if(m.type==='init')rlx.send({{type:'refresh',v:1}})}})</script>"
    )
}

/// Every app and plugin command the ACL knows, from the manifests tauri-build generated for
/// this build. Commands that could end the run (exit, close, hide …) are sorted last.
pub fn all_commands() -> Vec<String> {
    let manifests: Value =
        serde_json::from_str(ACL_MANIFESTS).expect("tauri-build wrote valid JSON");
    let mut commands = std::collections::BTreeSet::new();
    for (key, manifest) in manifests.as_object().into_iter().flatten() {
        let prefix = match key.as_str() {
            "__app-acl__" => String::new(),
            "core" => continue,
            core if core.starts_with("core:") => format!("plugin:{}|", &core[5..]),
            plugin => format!("plugin:{plugin}|"),
        };
        let permissions = manifest["permissions"].as_object().into_iter().flatten();
        for (_, permission) in permissions {
            for list in ["allow", "deny"] {
                for command in permission["commands"][list]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if let Some(command) = command.as_str() {
                        commands.insert(format!("{prefix}{command}"));
                    }
                }
            }
        }
    }
    let disruptive = |c: &String| {
        ["exit", "restart", "close", "destroy", "hide", "minimize"]
            .iter()
            .any(|word| c.contains(word))
    };
    let (mut late, mut early): (Vec<_>, Vec<_>) = commands.into_iter().partition(disruptive);
    early.append(&mut late);
    early
}

#[derive(Debug, Clone)]
struct CanaryCall {
    from: String,
    webview: String,
}

/// The probe's shared state: the canary's call log, accepted actions, the host-page script,
/// and the run itself (taken by [`setup`]).
pub struct Probe {
    canary: Mutex<Vec<CanaryCall>>,
    actions: Mutex<Vec<Value>>,
    host_script: String,
    run: Mutex<Option<Run>>,
    loaded: Mutex<Option<Sender<()>>>,
}

impl Probe {
    /// Reads [`ENV_REPORT`]. Unset, the probe is inert and only the canary exists.
    pub fn from_env() -> Self {
        let report = std::env::var_os(ENV_REPORT)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        let inert = Self {
            canary: Mutex::new(Vec::new()),
            actions: Mutex::new(Vec::new()),
            host_script: String::new(),
            run: Mutex::new(None),
            loaded: Mutex::new(None),
        };
        let Some(report) = report else {
            return inert;
        };

        let listeners = Listeners {
            host: Listener::start("host").expect("bind the host listener"),
            iframe: Listener::start("iframe").expect("bind the iframe listener"),
            control: Listener::start("control").expect("bind the control listener"),
        };
        let self_tests = [
            listeners.host.self_test(),
            listeners.iframe.self_test(),
            listeners.control.self_test(),
        ];
        let commands = all_commands();
        let config = json!({
            "port": listeners.host.port,
            "commands": commands,
            "channelFetch": CHANNEL_FETCH,
            "fixture": FIXTURE_ID,
            "builtin": BUILTIN_ID,
            "agent": AGENT_ID,
        });
        let (loaded_tx, loaded_rx) = mpsc::channel();
        Self {
            host_script: PROBE_HOST_JS.replace("__RLX_PROBE_CONFIG__", &config.to_string()),
            run: Mutex::new(Some(Run {
                report,
                listeners,
                self_tests,
                commands,
                loaded: loaded_rx,
            })),
            loaded: Mutex::new(Some(loaded_tx)),
            ..inert
        }
    }

    /// Called by the widget scheme for each action it accepted.
    pub fn record_action(&self, action: &widget_host::action::WidgetAction) {
        let value = serde_json::to_value(action).unwrap_or(Value::Null);
        lock(&self.actions).push(value);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl HostExtras for Probe {
    fn host_script(&self) -> Option<&str> {
        (!self.host_script.is_empty()).then_some("e2e/probe-host.js")
    }

    fn serve(&self, path: &str) -> Option<(&'static str, String)> {
        (path == "e2e/probe-host.js" && !self.host_script.is_empty())
            .then(|| ("text/javascript; charset=utf-8", self.host_script.clone()))
    }
}

/// The canary: granted to main only. Returns how many calls it has recorded.
#[tauri::command]
pub fn e2e_canary<R: Runtime>(
    probe: tauri::State<'_, Probe>,
    webview: Webview<R>,
    from: String,
) -> usize {
    let mut calls = lock(&probe.canary);
    calls.push(CanaryCall {
        from,
        webview: webview.label().to_owned(),
    });
    calls.len()
}

/// Call from the app's setup hook: grants the canary to main and starts the run, if any.
pub fn setup<R: Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("e2e-main-canary")
            .webview("main")
            .permission("allow-e2e-canary"),
    )?;
    let run = lock(&app.state::<Probe>().run).take();
    if let Some(run) = run {
        let handle = app.handle().clone();
        thread::Builder::new()
            .name("e2e-probe".into())
            .spawn(move || run.execute(handle))?;
    }
    Ok(())
}

/// Call from the app's page-load hook: the run starts once main has loaded.
pub fn page_loaded<R: Runtime>(webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
    if webview.label() == "main" && payload.event() == PageLoadEvent::Finished {
        let probe = webview.state::<Probe>();
        if let Some(tx) = lock(&probe.loaded).take() {
            let _ = tx.send(());
        }
    }
}

struct Listeners {
    host: Listener,
    iframe: Listener,
    control: Listener,
}

struct Run {
    report: PathBuf,
    listeners: Listeners,
    self_tests: [bool; 3],
    commands: Vec<String>,
    loaded: Receiver<()>,
}

impl Run {
    fn execute<R: Runtime>(self, app: AppHandle<R>) {
        let started = Instant::now();
        let mut errors: Vec<String> = Vec::new();
        if self.loaded.recv_timeout(Duration::from_secs(90)).is_err() {
            errors.push("main never finished loading".into());
        }

        // The switch, through the product API.
        let registry = app.state::<Registry>();
        let policy = registry.policy();
        let agent_register =
            describe(registry.register(Source::Agent, AGENT_ID, 1, &announcing_widget(AGENT_ID)));
        let builtin_register = describe(registry.register(
            Source::Builtin,
            BUILTIN_ID,
            1,
            &announcing_widget(BUILTIN_ID),
        ));

        // Where the OS has a widget webview, probe it: the fixture and the built-in control
        // go in as fixtures, whatever the policy says about built-ins.
        let fixture_html = PROBE_WIDGET_HTML
            .replace(
                "__RLX_PROBE_PORT__",
                &self.listeners.iframe.port.to_string(),
            )
            .replace(
                "__RLX_PROBE_COMMANDS__",
                &serde_json::to_string(&self.commands).unwrap_or_default(),
            )
            .replace("__RLX_PROBE_CHANNEL_FETCH__", CHANNEL_FETCH);
        let mut fixtures = "not registered: no widget webview on this OS".to_owned();
        if policy.widget_webview {
            fixtures = describe(registry.register_probe_fixture(FIXTURE_ID, 1, &fixture_html));
            if !registry.contains(BUILTIN_ID, 1) {
                let control =
                    registry.register_probe_fixture(BUILTIN_ID, 1, &announcing_widget(BUILTIN_ID));
                if let Err(error) = control {
                    errors.push(format!("built-in control: {error}"));
                }
            }
        }

        let attach = match app.get_window("main") {
            Some(window) => widget_host::attach(
                &window,
                policy,
                Bounds {
                    x: 540.0,
                    y: 300.0,
                    width: 400.0,
                    height: 320.0,
                },
            ),
            None => {
                errors.push("no main window".into());
                Err(widget_host::AttachError::NotOnThisOs)
            }
        };
        let attach_outcome = match &attach {
            Ok(_) => "attached".to_owned(),
            Err(error) => format!("refused: {error}"),
        };

        let main = app.get_webview("main");
        let main_script = MAIN_CONTROL_JS
            .replace(
                "__RLX_CONTROL_PORT__",
                &self.listeners.control.port.to_string(),
            )
            .replace(
                "__RLX_WIDGET_URL__",
                &widget_host::widget_url(BUILTIN_ID, 1),
            )
            .replace(
                "__RLX_ACTION_URL__",
                &format!("{}/host/action", widget_host::origin()),
            );
        if let Some(main) = &main
            && let Err(error) = main.eval(main_script)
        {
            errors.push(format!("eval in main: {error}"));
        }

        let mut host_report = Value::Null;
        let mut host_after_nav = Value::Null;
        if let Ok(widgets) = &attach {
            let ready =
                "typeof window.__rlxHost === 'object' && typeof window.__rlxProbe === 'object'";
            match wait_for(widgets, ready, Duration::from_secs(60)) {
                Some(Value::Bool(true)) => {}
                other => errors.push(format!("the host page never loaded: {other:?}")),
            }
            let entry = |id: &str, title: &str| json!({ "id": id, "version": 1, "url": widget_host::widget_url(id, 1), "title": title });
            let mount = json!([
                entry(FIXTURE_ID, "isolation probe"),
                entry(BUILTIN_ID, "built-in control"),
                entry(AGENT_ID, "agent-made (switch off)"),
            ]);
            if let Err(error) = widgets.eval(widget_host::mount_call(&registry, mount)) {
                errors.push(format!("mount: {error}"));
            }
            let done = "window.__rlxProbe && window.__rlxProbe.report.done ? JSON.stringify(window.__rlxProbe.report) : false";
            match wait_for(widgets, done, Duration::from_secs(150)) {
                Some(Value::String(text)) => {
                    host_report = serde_json::from_str(&text).unwrap_or(Value::String(text));
                }
                other => errors.push(format!("the host probe never finished: {other:?}")),
            }
            // Navigation goes last: if it isn't blocked, the page is gone.
            let _ = widgets.eval("window.__rlxProbe.navigate()");
            thread::sleep(Duration::from_secs(5));
            let after = "JSON.stringify({ href: location.href, frames: document.querySelectorAll('iframe').length })";
            host_after_nav = eval_value(widgets, after, Duration::from_secs(5))
                .and_then(|v| v.as_str().and_then(|s| serde_json::from_str(s).ok()))
                .unwrap_or(Value::Null);
        }

        let main_done = "window.__rlxMainProbe && window.__rlxMainProbe.done ? JSON.stringify(window.__rlxMainProbe) : false";
        let main_report = main
            .as_ref()
            .and_then(|main| wait_for(main, main_done, Duration::from_secs(30)))
            .and_then(|v| v.as_str().and_then(|s| serde_json::from_str(s).ok()))
            .unwrap_or_else(|| {
                errors.push("the main control never finished".into());
                Value::Null
            });

        // Late connections (a preconnect, a slow navigation) still count.
        thread::sleep(Duration::from_secs(2));
        let probe = app.state::<Probe>();
        let canary: Vec<Value> = lock(&probe.canary)
            .iter()
            .map(|call| json!({ "from": call.from, "webview": call.webview }))
            .collect();
        let actions = lock(&probe.actions).clone();
        let mut webviews: Vec<String> = app.webviews().into_keys().collect();
        webviews.sort();
        let listener = |name: &str, l: &Listener, self_test: bool| json!({ "name": name, "port": l.port, "selfTest": self_test, "hits": l.hits() });

        let report = json!({
            "schema": 2,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "elapsedMs": started.elapsed().as_millis() as u64,
            "policy": PolicyInfo::from(policy),
            "switch": {
                "agentRegister": agent_register,
                "builtinRegister": builtin_register,
                "fixtures": fixtures,
                "attach": attach_outcome,
            },
            "webviews": webviews,
            "commandCount": self.commands.len(),
            "host": host_report,
            "hostAfterNavigation": host_after_nav,
            "main": main_report,
            "canary": canary,
            "actions": actions,
            "listeners": {
                "host": listener("host", &self.listeners.host, self.self_tests[0]),
                "iframe": listener("iframe", &self.listeners.iframe, self.self_tests[1]),
                "control": listener("control", &self.listeners.control, self.self_tests[2]),
            },
            "errors": errors,
        });
        write_report(&self.report, &report);
    }
}

fn describe(result: Result<String, widget_host::RegisterError>) -> String {
    match result {
        Ok(url) => format!("registered: {url}"),
        Err(error) => format!("refused: {error}"),
    }
}

/// Evaluates `js` in `webview` and returns its JSON value, or None after `timeout`.
fn eval_value<R: Runtime>(webview: &Webview<R>, js: &str, timeout: Duration) -> Option<Value> {
    let (tx, rx): (Sender<String>, Receiver<String>) = mpsc::channel();
    let tx = Mutex::new(tx);
    webview
        .eval_with_callback(js.to_owned(), move |result| {
            let _ = lock(&tx).send(result);
        })
        .ok()?;
    let raw = rx.recv_timeout(timeout).ok()?;
    serde_json::from_str(&raw).ok().or(Some(Value::String(raw)))
}

/// Polls `js` until it returns something other than `false` or null, or `timeout` passes.
fn wait_for<R: Runtime>(webview: &Webview<R>, js: &str, timeout: Duration) -> Option<Value> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match eval_value(webview, js, Duration::from_secs(5)) {
            Some(Value::Bool(false) | Value::Null) | None => {}
            Some(value) => return Some(value),
        }
        thread::sleep(Duration::from_millis(250));
    }
    None
}

/// Writes the report atomically, since the runner polls for the file.
fn write_report(path: &PathBuf, report: &Value) {
    let text = serde_json::to_string_pretty(report).unwrap_or_default();
    let partial = path.with_extension("partial");
    let written = std::fs::write(&partial, text).and_then(|_| std::fs::rename(&partial, path));
    if let Err(error) = written {
        eprintln!("e2e: could not write {}: {error}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_list_covers_app_and_core_plugin_commands() {
        let commands = all_commands();
        assert!(commands.len() > 100, "only {} commands", commands.len());
        for expected in [
            "app_info",
            "report_first_paint",
            "widgets_show",
            "widgets_register",
            "e2e_canary",
            "plugin:window|set_title",
            "plugin:webview|create_webview_window",
            "plugin:event|emit",
            "plugin:app|exit",
            "plugin:tray|new",
        ] {
            assert!(commands.iter().any(|c| c == expected), "missing {expected}");
        }
        assert!(!commands.iter().any(|c| c == CHANNEL_FETCH));
        let exit = commands
            .iter()
            .position(|c| c == "plugin:app|exit")
            .unwrap();
        let title = commands
            .iter()
            .position(|c| c == "plugin:window|set_title")
            .unwrap();
        assert!(title < exit, "disruptive commands go last");
    }

    #[test]
    fn templates_have_their_placeholders() {
        assert!(PROBE_HOST_JS.contains("__RLX_PROBE_CONFIG__"));
        for placeholder in [
            "__RLX_PROBE_PORT__",
            "__RLX_PROBE_COMMANDS__",
            "__RLX_PROBE_CHANNEL_FETCH__",
        ] {
            assert!(PROBE_WIDGET_HTML.contains(placeholder), "{placeholder}");
        }
        for placeholder in [
            "__RLX_CONTROL_PORT__",
            "__RLX_WIDGET_URL__",
            "__RLX_ACTION_URL__",
        ] {
            assert!(MAIN_CONTROL_JS.contains(placeholder), "{placeholder}");
        }
    }
}
