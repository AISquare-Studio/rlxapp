//! The widget host (docs/architecture.md §5.3).
//!
//! Widgets never render in the main webview, whose CSP allows no frames. Where this OS has a
//! widget webview, they render in one child webview labelled [`LABEL`], laid over the Home
//! area. It holds a host page the app ships, plus one `<iframe sandbox="allow-scripts">` per
//! widget. The core serves all of it from the [`SCHEME`] scheme, each route with its own CSP
//! header.
//!
//! # Isolation
//! - **No capability.** `capabilities/default.json` names `webviews: ["main"]`, never a
//!   window, and build.rs declares every app command in the app manifest. So every command
//!   from `widgets` fails "not allowed by ACL". The probe (`--features e2e`) checks this in the
//!   built app.
//! - **No IPC needed.** The core drives the host page only by `Webview::eval` of the two
//!   functions in host.js. Arguments go in as serde_json output ([`host_call`]), never as
//!   interpolated strings. The core keeps what the page should show and replays it on every
//!   page load ([`state`]), so nothing depends on timing and a reload restores the grid.
//! - **Actions** come out as POSTs to `/host/action` ([`action`]). They are accepted only
//!   from the `widgets` label and the host origin, then validated against §5.2.
//! - **Navigation** in the widgets webview stays on the scheme ([`allow_navigation`]), and the
//!   host CSP's frame-src holds every frame there. New windows are denied.
//! - **WebRTC** is removed from every frame (frames.js), since CSP doesn't govern it.
//! - **The switch.** [`policy`] keeps agent-made widgets off on every OS until the isolation
//!   probe passes there and the owner turns them on.
//!
//! # Per OS in v0 ([`policy`])
//! - macOS: built-ins render in the widget webview. Agent-made widgets are off.
//! - Windows: no widget webview in v0. Built-ins render as escaped React in main, as on Linux,
//!   and agent-made widgets are off, so nothing would render there. Not attaching it also
//!   keeps WebView2's subframe script injection out of reach. The isolation probe still
//!   attaches one in test builds, to measure WebView2 for later.
//! - Linux: no widget webview, since WebKitGTK can't place a child webview. Built-ins render
//!   in main. Agent-made widgets are off.
//!
//! # API for the UI (main webview only; see commands.rs)
//! The commands are granted to `main` in capabilities/default.json. Through `invoke`:
//! - `widgets_policy()` → [`PolicyInfo`]: whether a widget webview exists, where built-ins
//!   render (`"widgets"` or `"main"`), and the agent-widget switch.
//! - `widgets_show({ bounds })` (async): attach the widgets webview on first use, then place
//!   and show it. `bounds` is `{ x, y, width, height }` in logical px relative to the window:
//!   the Home grid's rect. Call it again on every layout change. It fails where
//!   `widgetWebview` is false.
//! - `widgets_hide()`: hide it while a main-window menu, modal or toast covers Home, since
//!   the child webview always draws above main.
//! - `widgets_mount({ widgets: [{ id, version, title }] })` (async): mount registered widgets.
//!   The core builds their URLs; unknown IDs are skipped. It resolves once the host page has
//!   mounted them, with the IDs it reports, and fails if the page doesn't answer. Mounted
//!   widgets stay mounted across reloads of the widgets webview.
//! - `widgets_push({ id, data })`: give a mounted widget its data (`ToWidget` `data`, §5.2).
//!   The core keeps the latest per widget: it is sent now if the page is loaded, and again
//!   after every reload. A frame whose port doesn't exist yet gets it once the port exists.
//! - `widgets_register({ id, version, html })`: register widget HTML from the UI. It is
//!   always treated as agent-made, so it is refused while the switch is off. Built-ins are
//!   registered by the core, never by the UI. An ID and version can be registered once.
//! - The `widget-action` event, emitted to main only, carries each accepted action:
//!   [`action::WidgetAction`] `{ widgetId, message }`, where `message` is a `FromWidget`.

pub mod action;
pub mod commands;
pub mod state;

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{
    LogicalPosition, LogicalSize, Runtime, Url, Webview, WebviewBuilder, WebviewUrl, Window,
};

/// The custom scheme that serves the host page and the widget documents.
pub const SCHEME: &str = "rlxwidget";

/// The label of the child webview that hosts every widget.
pub const LABEL: &str = "widgets";

/// The event that carries accepted widget actions to the main webview.
pub const ACTION_EVENT: &str = "widget-action";

/// The CSP of a widget document (§5.3), sent as a header and repeated as its first `<meta>`:
/// inline script and style only, no network, no frames, no forms and no base URL.
pub const WIDGET_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/// The widget CSP as the response header sends it: plus `sandbox allow-scripts`, which only
/// a header can carry. A widget document then has an opaque origin wherever it loads, even
/// as a top frame.
pub const WIDGET_CSP_HEADER: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

/// The CSP of the host page (§5.3). Its frames may load only the widget scheme, which also
/// keeps a widget from navigating its own frame anywhere else. `connect-src 'self'` is for
/// `/host/action`.
pub const HOST_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src rlxwidget: http://rlxwidget.localhost; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

/// A widget is one self-contained HTML file of at most 512 KB (§5.1).
pub const MAX_WIDGET_BYTES: usize = 512 * 1024;

const HOST_HTML: &str = include_str!("host.html");
const HOST_JS: &str = include_str!("host.js");
/// Runs first in every frame of the `widgets` webview and removes WebRTC (see the file).
const FRAMES_JS: &str = include_str!("frames.js");
/// The widget SDK, inlined ahead of every widget document (see the file).
const SDK_JS: &str = include_str!("sdk.js");

/// The origin every widget-scheme URL uses on this OS. WebView2 serves custom schemes only as
/// `http://<scheme>.<host>`, so on Windows the pages use that form themselves (§5.3, §12).
pub fn origin() -> &'static str {
    if cfg!(windows) {
        "http://rlxwidget.localhost"
    } else {
        "rlxwidget://localhost"
    }
}

/// The host page's URL.
pub fn host_url() -> String {
    format!("{}/host/", origin())
}

/// The URL a widget document loads from. The ID and version stay in the path, so every widget
/// shares one origin per OS (§5.3).
pub fn widget_url(id: &str, version: u32) -> String {
    format!("{}/{id}/{version}/", origin())
}

/// Who wrote a widget (§5.1 `source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Builtin,
    Agent,
    User,
}

/// Whether agent-made (and user-made) widgets may load on this OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Switch {
    On,
    /// Off, with the reason (shown to the UI and in the probe report).
    Off(&'static str),
}

/// Where built-in widgets render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    /// In the `widgets` child webview, like every other widget.
    Widgets,
    /// As escaped React in the main webview.
    Main,
}

/// What this OS does with widgets in v0 (§5.3, §12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// Whether the `widgets` child webview exists on this OS.
    pub widget_webview: bool,
    /// Where built-ins render.
    pub builtins: Placement,
    /// Whether agent-made widgets may load.
    pub agent_widgets: Switch,
}

/// The v0 policy for the OS this build targets.
///
/// Agent-made widgets stay off until the isolation probe passes on that OS (§5.3) and the
/// owner decides to turn them on: a reviewed one-line change here.
pub const fn policy() -> Policy {
    if cfg!(target_os = "linux") {
        Policy {
            widget_webview: false,
            builtins: Placement::Main,
            agent_widgets: Switch::Off(
                "off on Linux: no widget webview in v0 (WebKitGTK can't place one)",
            ),
        }
    } else if cfg!(windows) {
        Policy {
            widget_webview: false,
            builtins: Placement::Main,
            agent_widgets: Switch::Off(
                "off on Windows: no widget webview in v0 until the isolation probe passes there",
            ),
        }
    } else {
        Policy {
            widget_webview: true,
            builtins: Placement::Widgets,
            agent_widgets: Switch::Off("off on macOS until the isolation probe passes there"),
        }
    }
}

/// The policy as the UI sees it (`widgets_policy`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyInfo {
    pub widget_webview: bool,
    pub builtins: Placement,
    /// `"on"`, or `"off: <reason>"`.
    pub agent_widgets: String,
}

impl From<Policy> for PolicyInfo {
    fn from(policy: Policy) -> Self {
        Self {
            widget_webview: policy.widget_webview,
            builtins: policy.builtins,
            agent_widgets: match policy.agent_widgets {
                Switch::On => "on".to_owned(),
                Switch::Off(reason) => format!("off: {reason}"),
            },
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RegisterError {
    BadId,
    TooLarge(usize),
    /// This OS has no widget webview (Linux in v0).
    NoWidgetWebview,
    /// Built-ins render as React in main on this OS.
    BuiltinsInMain,
    /// Agent-made and user-made widgets are off on this OS.
    AgentWidgetsOff(&'static str),
    /// This ID and version are already registered: a document is never replaced.
    AlreadyRegistered,
    /// A built-in uses an HTML sink (see [`BUILTIN_HTML_SINKS`]).
    UnsafeBuiltin(&'static str),
}

impl fmt::Display for RegisterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadId => write!(f, "widget ids are 1-64 letters, digits, '-' or '_'"),
            Self::TooLarge(n) => write!(f, "widget is {n} bytes; the limit is {MAX_WIDGET_BYTES}"),
            Self::NoWidgetWebview => write!(f, "this OS has no widget webview in v0"),
            Self::BuiltinsInMain => write!(f, "built-ins render in main on this OS"),
            Self::AgentWidgetsOff(reason) => write!(f, "agent-made widgets are {reason}"),
            Self::AlreadyRegistered => {
                write!(f, "that widget id and version are already registered")
            }
            Self::UnsafeBuiltin(sink) => write!(
                f,
                "built-ins render connector text with textContent only; this one uses {sink}"
            ),
        }
    }
}

impl std::error::Error for RegisterError {}

/// 1-64 letters, digits, `-` or `_`, and not `host`, which names the host page's routes.
pub(crate) fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id != "host"
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// HTML sinks a built-in may not use while WebKit's preconnect still ignores CSP: a built-in
/// renders connector text (Slack, email), and markup parsed from that text could reach the
/// network through a `<link>`. Built-ins set text with `textContent` only. Lift this once
/// the widgets webview has a deny-all network proxy.
pub const BUILTIN_HTML_SINKS: &[&str] = &[
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
    "DOMParser",
    "createContextualFragment",
    "srcdoc",
    "setHTMLUnsafe",
];

/// The widget documents the core serves, keyed by `<id>/<version>`, and the launch's host
/// token (see [`action`]).
pub struct Registry {
    policy: Policy,
    docs: Mutex<HashMap<String, (Source, String)>>,
    host_token: String,
}

/// 128 bits from std's `RandomState`, whose keys come from the OS RNG. The token only has to
/// be unguessable from inside a sandboxed frame, which can observe nothing of this process.
fn new_host_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    (0u8..2)
        .map(|i| {
            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
            hasher.write_u8(i);
            format!("{:016x}", hasher.finish())
        })
        .collect()
}

impl Default for Registry {
    fn default() -> Self {
        Self::new(policy())
    }
}

impl Registry {
    pub fn new(policy: Policy) -> Self {
        Self {
            policy,
            docs: Mutex::new(HashMap::new()),
            host_token: new_host_token(),
        }
    }

    pub fn policy(&self) -> Policy {
        self.policy
    }

    /// The token the host page must send with every action. Only `host_call` passes it on.
    pub(crate) fn host_token(&self) -> &str {
        &self.host_token
    }

    /// Registers a widget document and returns the URL it mounts from, if the policy allows:
    /// nothing registers without a widget webview, built-ins only where they render in it,
    /// and agent/user widgets only with the switch on.
    pub fn register(
        &self,
        source: Source,
        id: &str,
        version: u32,
        html: &str,
    ) -> Result<String, RegisterError> {
        if !self.policy.widget_webview {
            return Err(RegisterError::NoWidgetWebview);
        }
        match (source, self.policy.builtins, self.policy.agent_widgets) {
            (Source::Builtin, Placement::Main, _) => return Err(RegisterError::BuiltinsInMain),
            (Source::Agent | Source::User, _, Switch::Off(reason)) => {
                return Err(RegisterError::AgentWidgetsOff(reason));
            }
            _ => {}
        }
        if source == Source::Builtin
            && let Some(sink) = BUILTIN_HTML_SINKS.iter().find(|sink| html.contains(**sink))
        {
            return Err(RegisterError::UnsafeBuiltin(sink));
        }
        self.insert(source, id, version, html)
    }

    /// Stores a document without consulting the policy. Only the isolation probe uses this,
    /// for its fixture (standing in for an agent-made widget) and its built-in control, so it
    /// can probe the widget webview wherever one exists.
    #[cfg(feature = "e2e")]
    pub fn register_probe_fixture(
        &self,
        source: Source,
        id: &str,
        version: u32,
        html: &str,
    ) -> Result<String, RegisterError> {
        self.insert(source, id, version, html)
    }

    fn insert(
        &self,
        source: Source,
        id: &str,
        version: u32,
        html: &str,
    ) -> Result<String, RegisterError> {
        if !valid_id(id) {
            return Err(RegisterError::BadId);
        }
        if html.len() > MAX_WIDGET_BYTES {
            return Err(RegisterError::TooLarge(html.len()));
        }
        let mut docs = self.lock_docs();
        let key = format!("{id}/{version}");
        if docs.contains_key(&key) {
            return Err(RegisterError::AlreadyRegistered);
        }
        docs.insert(key, (source, html.to_owned()));
        Ok(widget_url(id, version))
    }

    fn lock_docs(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Source, String)>> {
        self.docs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn contains(&self, id: &str, version: u32) -> bool {
        self.lock_docs().contains_key(&format!("{id}/{version}"))
    }

    /// Whether any version of `id` is registered: the action route takes nothing else.
    pub(crate) fn has_id(&self, id: &str) -> bool {
        let prefix = format!("{id}/");
        self.lock_docs().keys().any(|key| key.starts_with(&prefix))
    }

    /// Who wrote a registered document.
    pub fn source(&self, id: &str, version: u32) -> Option<Source> {
        self.lock_docs()
            .get(&format!("{id}/{version}"))
            .map(|(source, _)| *source)
    }

    fn document(&self, key: &str) -> Option<String> {
        self.lock_docs().get(key).map(|(_, html)| html.clone())
    }
}

/// Extra host-page routes. The isolation probe adds its script here; product builds add none.
pub trait HostExtras: Send + Sync {
    /// A path under `/host/` for a script to load after host.js, if any.
    fn host_script(&self) -> Option<&str>;
    /// Serves `/host/<path>` for a path the host doesn't own.
    fn serve(&self, path: &str) -> Option<(&'static str, String)>;
}

/// Answers a request on the widget scheme. Returns the response, and the action to deliver to
/// main if the request was an accepted `/host/action` POST.
///
/// - Only the `widgets` webview is served: anything else (main, or a webview added later)
///   gets 403, so loading the scheme elsewhere yields nothing.
/// - `POST /host/action` is the action route ([`action::accept`]). Everything else is GET.
/// - `/host/` and `/host/host.js` are the host page; `/<id>/<version>/` is a widget document.
/// - Every response carries a CSP: the host CSP on host routes, the widget CSP otherwise.
pub fn respond(
    registry: &Registry,
    extras: Option<&dyn HostExtras>,
    webview_label: &str,
    request: &Request<Vec<u8>>,
) -> (Response<Vec<u8>>, Option<action::WidgetAction>) {
    let path = request.uri().path();
    let is_host_route = path == "/host" || path.starts_with("/host/");
    let csp = if is_host_route {
        HOST_CSP
    } else {
        WIDGET_CSP_HEADER
    };
    let reply = |status: StatusCode, content_type: &str, body: Vec<u8>| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_SECURITY_POLICY, csp)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(header::CACHE_CONTROL, "no-store")
            .header("Referrer-Policy", "no-referrer")
            .body(body)
            .unwrap_or_else(|_| Response::new(Vec::new()))
    };
    let text = |status: StatusCode, message: &str| {
        reply(
            status,
            "text/plain; charset=utf-8",
            message.as_bytes().to_vec(),
        )
    };

    if webview_label != LABEL {
        let message = "the widget scheme serves only the widgets webview";
        return (text(StatusCode::FORBIDDEN, message), None);
    }

    if path == "/host/action" {
        let header_text = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
        };
        let route = action::RouteRequest {
            webview_label,
            origin: header_text(header::ORIGIN.as_str()),
            token: header_text(action::TOKEN_HEADER),
            is_post: request.method() == tauri::http::Method::POST,
            body: request.body(),
        };
        return match action::accept(&route, registry.host_token(), &|id| registry.has_id(id)) {
            Ok(accepted) => (text(StatusCode::ACCEPTED, "accepted"), Some(accepted)),
            Err(error) => (text(error.status(), &error.to_string()), None),
        };
    }
    if request.method() != tauri::http::Method::GET {
        return (text(StatusCode::METHOD_NOT_ALLOWED, "GET only"), None);
    }

    if is_host_route {
        let rest = path.strip_prefix("/host").unwrap_or_default();
        let rest = rest.strip_prefix('/').unwrap_or(rest);
        let response = match rest {
            "" | "index.html" => {
                let extra = extras
                    .and_then(|e| e.host_script())
                    .map(|src| format!("<script src=\"/host/{src}\"></script>"))
                    .unwrap_or_default();
                let html = HOST_HTML.replace("<!--extra-scripts-->", &extra);
                reply(
                    StatusCode::OK,
                    "text/html; charset=utf-8",
                    html.into_bytes(),
                )
            }
            "host.js" => reply(
                StatusCode::OK,
                "text/javascript; charset=utf-8",
                HOST_JS.as_bytes().to_vec(),
            ),
            other => match extras.and_then(|e| e.serve(other)) {
                Some((content_type, body)) => {
                    reply(StatusCode::OK, content_type, body.into_bytes())
                }
                None => text(StatusCode::NOT_FOUND, "no such host route"),
            },
        };
        return (response, None);
    }

    let key = path.trim_matches('/');
    let response = match registry.document(key) {
        Some(html) => reply(
            StatusCode::OK,
            "text/html; charset=utf-8",
            with_preamble(&html).into_bytes(),
        ),
        None => text(StatusCode::NOT_FOUND, "no such widget"),
    };
    (response, None)
}

/// Puts the widget CSP in a `<meta>` ahead of everything the widget wrote, so it applies even
/// where a webview ignores a custom scheme's response headers, then the widget SDK, then the
/// widget with its `<link>` tags made inert ([`inert_links`]).
fn with_preamble(html: &str) -> String {
    format!(
        "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"{WIDGET_CSP}\"><script>{SDK_JS}</script>{}",
        inert_links(html)
    )
}

/// Renames every `<link` tag to `<x-link`, an unknown element that fetches nothing.
///
/// WebKit opens a connection for `<link rel=preconnect>` (and dns-prefetch, prefetch,
/// preload) despite the widget CSP, which the isolation probe found. A widget is one
/// self-contained file with inline JS and CSS (§5.1), so it has no use for `<link>` at all.
/// This is defence in depth only: script can still build a link at run time, which only a
/// deny-all network proxy for the widgets webview stops.
pub fn inert_links(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() + 16);
    let mut last = 0;
    let mut search = 0;
    while let Some(found) = lower[search..].find("<link") {
        let at = search + found;
        let next = lower.as_bytes().get(at + 5).copied();
        let is_tag = matches!(
            next,
            None | Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'/' | b'>')
        );
        if is_tag {
            out.push_str(&html[last..at]);
            out.push_str("<x-link");
            last = at + 5;
        }
        search = at + 5;
    }
    out.push_str(&html[last..]);
    out
}

/// The host page's functions the core may call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostFn {
    /// `mount([{ id, version, url, title }], hostToken)`
    Mount,
    /// `data(id, payload)`
    Data,
}

/// The one way the core builds script for the host page: a fixed function, with every
/// argument as serde_json output. No caller string is ever interpolated into script. Only
/// the page-load replay ([`state::HostState::page_finished`]) passes the host token.
pub fn host_call(function: HostFn, args: &[Value]) -> String {
    let name = match function {
        HostFn::Mount => "mount",
        HostFn::Data => "data",
    };
    let args: Vec<String> = args
        .iter()
        .map(|arg| serde_json::to_string(arg).unwrap_or_else(|_| "null".to_owned()))
        .collect();
    format!("window.__rlxHost.{name}({})", args.join(","))
}

/// The `widgets` webview may stay on the widget scheme and nothing else (§5.3). wry asks this
/// for every navigation on macOS, but only for top-level ones on Windows; there the host CSP's
/// frame-src is what keeps a frame on the scheme.
pub fn allow_navigation(url: &Url) -> bool {
    if matches!(url.as_str(), "about:blank" | "about:srcdoc") {
        return true;
    }
    let prefix = format!("{}/", origin());
    url.as_str().starts_with(&prefix)
}

/// Where the widgets webview sits, in logical px relative to the window.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug)]
pub enum AttachError {
    /// The policy says this OS has no widget webview.
    NotOnThisOs,
    Tauri(tauri::Error),
}

impl fmt::Display for AttachError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotOnThisOs => write!(f, "this OS has no widget webview in v0"),
            Self::Tauri(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for AttachError {}

/// Adds the `widgets` child webview to `window` at `bounds`, loading the host page. Use
/// `widgets_show` from the UI; this is the core's side of it. Call it off the main thread
/// and never from a synchronous command: `add_child` waits on the main thread, and on
/// Windows that deadlocks a synchronous command.
pub fn attach<R: Runtime>(
    window: &Window<R>,
    policy: Policy,
    bounds: Bounds,
) -> Result<Webview<R>, AttachError> {
    if !policy.widget_webview {
        return Err(AttachError::NotOnThisOs);
    }
    add_widgets_webview(window, bounds)
}

/// Attaches the widgets webview whatever the policy says. Only the isolation probe uses
/// this, to measure WebView2 on Windows, where the product attaches none in v0.
#[cfg(feature = "e2e")]
pub fn attach_for_probe<R: Runtime>(
    window: &Window<R>,
    bounds: Bounds,
) -> Result<Webview<R>, AttachError> {
    add_widgets_webview(window, bounds)
}

fn add_widgets_webview<R: Runtime>(
    window: &Window<R>,
    bounds: Bounds,
) -> Result<Webview<R>, AttachError> {
    use tauri::Manager;
    let url = Url::parse(&format!("{SCHEME}://localhost/host/")).expect("static URL parses");
    let mut builder = WebviewBuilder::new(LABEL, WebviewUrl::CustomProtocol(url));
    // WebView2 shares one browser process per user-data folder, and refuses a second
    // environment with other options (0x8007139F). So the widgets webview takes the main
    // window's browser arguments, if the config sets any. Other webviews ignore them.
    let main_args = window
        .app_handle()
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .and_then(|w| w.additional_browser_args.clone());
    if let Some(args) = main_args {
        builder = builder.additional_browser_args(&args);
    }
    let builder = builder
        .on_navigation(|url| {
            let allowed = allow_navigation(url);
            #[cfg(feature = "e2e")]
            crate::e2e::record_navigation(url.as_str(), allowed);
            allowed
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .initialization_script_for_all_frames(FRAMES_JS)
        // Every page load of the host page: replay the grid and the data ([`state`]).
        .on_page_load(|webview, payload| {
            let state = webview.state::<state::HostState>();
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => state.page_started(),
                tauri::webview::PageLoadEvent::Finished => {
                    let replay = state.page_finished(&webview.state::<Registry>());
                    if let Err(error) = webview.eval(replay) {
                        eprintln!("widgets: replay after page load failed: {error}");
                    }
                }
            }
        })
        .transparent(true);
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(AttachError::Tauri)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ON: Policy = Policy {
        widget_webview: true,
        builtins: Placement::Widgets,
        agent_widgets: Switch::On,
    };
    const OFF: Policy = Policy {
        widget_webview: true,
        builtins: Placement::Widgets,
        agent_widgets: Switch::Off("off for the test"),
    };
    const BUILTINS_IN_MAIN: Policy = Policy {
        widget_webview: true,
        builtins: Placement::Main,
        agent_widgets: Switch::Off("off for the test"),
    };
    const NONE: Policy = Policy {
        widget_webview: false,
        builtins: Placement::Main,
        agent_widgets: Switch::Off("no widget webview"),
    };

    fn get(path: &str) -> Request<Vec<u8>> {
        Request::builder()
            .uri(format!("{}{path}", origin()))
            .body(Vec::new())
            .unwrap()
    }

    fn json_file(path: &std::path::Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn v0_keeps_agent_widgets_off_on_every_os() {
        let policy = policy();
        assert!(matches!(policy.agent_widgets, Switch::Off(_)));
        // Only macOS attaches a widget webview in v0; Windows and Linux render built-ins in main.
        assert_eq!(policy.widget_webview, cfg!(target_os = "macos"));
        let builtins = if cfg!(target_os = "macos") {
            Placement::Widgets
        } else {
            Placement::Main
        };
        assert_eq!(policy.builtins, builtins);
        let info = PolicyInfo::from(policy);
        assert!(info.agent_widgets.starts_with("off: "));
    }

    #[test]
    fn the_widgets_webview_has_no_capability() {
        // Every capability file: none may name the widgets webview, none may use `windows`
        // (a window grant would reach every webview in it, widgets included), and none may
        // use a wildcard.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut files = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let capability = json_file(&path);
            files += 1;
            assert!(
                capability.get("windows").is_none(),
                "{path:?} grants windows"
            );
            let webviews: Vec<&str> = capability["webviews"]
                .as_array()
                .unwrap_or_else(|| panic!("{path:?} names no webviews"))
                .iter()
                .map(|w| w.as_str().unwrap())
                .collect();
            assert!(!webviews.contains(&LABEL), "{path:?} grants {LABEL}");
            assert!(!webviews.iter().any(|w| w.contains('*')), "{path:?}");
            assert_eq!(webviews, ["main"], "{path:?}");
        }
        assert!(files >= 1);
    }

    #[test]
    fn the_switch_refuses_agent_and_user_widgets_when_off() {
        let registry = Registry::new(OFF);
        for source in [Source::Agent, Source::User] {
            assert_eq!(
                registry.register(source, "w", 1, "<p>x</p>"),
                Err(RegisterError::AgentWidgetsOff("off for the test"))
            );
        }
        assert!(
            registry
                .register(Source::Builtin, "w", 1, "<p>x</p>")
                .is_ok()
        );
        let on = Registry::new(ON);
        assert!(on.register(Source::Agent, "w", 1, "<p>x</p>").is_ok());
    }

    #[test]
    fn built_ins_in_main_never_register_in_the_widget_webview() {
        let registry = Registry::new(BUILTINS_IN_MAIN);
        assert_eq!(
            registry.register(Source::Builtin, "clock", 1, "<p>x</p>"),
            Err(RegisterError::BuiltinsInMain)
        );
        assert!(!registry.contains("clock", 1));
    }

    #[test]
    fn no_widget_webview_means_nothing_registers() {
        let registry = Registry::new(NONE);
        for source in [Source::Builtin, Source::Agent, Source::User] {
            assert_eq!(
                registry.register(source, "w", 1, "<p>x</p>"),
                Err(RegisterError::NoWidgetWebview)
            );
        }
    }

    #[test]
    fn rejects_bad_ids_and_oversized_documents() {
        let registry = Registry::new(ON);
        for id in ["", "../x", "a/b", "a b", &"x".repeat(65)] {
            assert_eq!(
                registry.register(Source::Builtin, id, 1, ""),
                Err(RegisterError::BadId),
                "{id}"
            );
        }
        let big = "x".repeat(MAX_WIDGET_BYTES + 1);
        assert_eq!(
            registry.register(Source::Builtin, "ok", 1, &big),
            Err(RegisterError::TooLarge(MAX_WIDGET_BYTES + 1))
        );
    }

    #[test]
    fn serves_widgets_with_the_csp_header_then_meta_then_the_sdk() {
        let registry = Registry::new(ON);
        let url = registry
            .register(Source::Builtin, "clock", 2, "<p>hi</p>")
            .unwrap();
        assert_eq!(url, widget_url("clock", 2));
        let (response, action) = respond(&registry, None, LABEL, &get("/clock/2/"));
        assert!(action.is_none());
        assert_eq!(response.status(), StatusCode::OK);
        // The header adds `sandbox allow-scripts`, which a <meta> can't carry.
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            WIDGET_CSP_HEADER
        );
        assert_eq!(
            WIDGET_CSP_HEADER,
            format!("{WIDGET_CSP}; sandbox allow-scripts")
        );
        let body = String::from_utf8(response.body().clone()).unwrap();
        let meta = format!(
            "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"{WIDGET_CSP}\"><script>"
        );
        assert!(body.starts_with(&meta), "{body}");
        assert!(body.contains(SDK_JS));
        assert!(body.ends_with("</script><p>hi</p>"));
    }

    #[test]
    fn link_tags_in_widget_html_are_inert() {
        let html = "<LINK rel=preconnect href=//a.example><link\nrel=dns-prefetch href=//b.example>\
                    <Link/rel=prefetch href=/x><link>\
                    <linkage>ok</linkage><p>&lt;link rel=preconnect&gt;</p>";
        let inert = inert_links(html);
        assert!(
            !inert.to_ascii_lowercase().contains("<link ")
                && !inert.to_ascii_lowercase().contains("<link\n")
        );
        assert_eq!(inert.matches("<x-link").count(), 4, "{inert}");
        assert!(
            inert.contains("<linkage>ok</linkage>"),
            "other tags are untouched"
        );
        assert!(
            inert.contains("&lt;link rel=preconnect&gt;"),
            "text is untouched"
        );

        let registry = Registry::new(ON);
        registry
            .register(
                Source::Builtin,
                "w",
                1,
                "<link rel=preconnect href=//a.example><p>w</p>",
            )
            .unwrap();
        let (response, _) = respond(&registry, None, LABEL, &get("/w/1/"));
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert!(
            body.ends_with("<x-link rel=preconnect href=//a.example><p>w</p>"),
            "{body}"
        );
    }

    #[test]
    fn the_sdk_accepts_init_once_and_only_from_the_parent() {
        assert!(SDK_JS.contains("event.source !== window.parent"));
        assert!(SDK_JS.contains("if (port ||"));
    }

    #[test]
    fn serves_only_the_widgets_webview() {
        let registry = Registry::new(ON);
        registry
            .register(Source::Builtin, "clock", 1, "<p>hi</p>")
            .unwrap();
        for label in ["main", "widgets2", ""] {
            for path in ["/clock/1/", "/host/", "/host/host.js"] {
                let (response, _) = respond(&registry, None, label, &get(path));
                assert_eq!(response.status(), StatusCode::FORBIDDEN, "{label} {path}");
                assert!(
                    response
                        .headers()
                        .contains_key(header::CONTENT_SECURITY_POLICY)
                );
            }
        }
        let post = Request::builder()
            .method("POST")
            .uri(format!("{}/clock/1/", origin()))
            .body(b"{}".to_vec())
            .unwrap();
        let (response, _) = respond(&registry, None, LABEL, &post);
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[test]
    fn serves_the_host_page_with_the_host_csp() {
        let registry = Registry::new(ON);
        let (page, _) = respond(&registry, None, LABEL, &get("/host/"));
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.headers()[header::CONTENT_SECURITY_POLICY], HOST_CSP);
        let html = String::from_utf8(page.body().clone()).unwrap();
        assert!(html.contains("<script src=\"/host/host.js\"></script>"));
        assert!(!html.contains("<!--extra-scripts-->"));
        let (script, _) = respond(&registry, None, LABEL, &get("/host/host.js"));
        assert_eq!(script.status(), StatusCode::OK);
        assert_eq!(
            script.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        for missing in ["/host/nope.js", "/nope/1/", "/"] {
            let (response, _) = respond(&registry, None, LABEL, &get(missing));
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{missing}");
        }
    }

    #[test]
    fn the_action_route_takes_actions_only_from_the_host_page_top_frame() {
        let registry = Registry::new(ON);
        registry
            .register(Source::Builtin, "clock", 1, "<p>clock</p>")
            .unwrap();
        let refresh = br#"{"widgetId":"clock","message":{"type":"refresh","v":1}}"#.to_vec();
        let post = |token: Option<&str>, origin_header: Option<&str>| {
            let mut builder = Request::builder()
                .method("POST")
                .uri(format!("{}/host/action", origin()));
            if let Some(token) = token {
                builder = builder.header(action::TOKEN_HEADER, token);
            }
            if let Some(value) = origin_header {
                builder = builder.header(header::ORIGIN, value);
            }
            builder.body(refresh.clone()).unwrap()
        };
        let token = registry.host_token().to_owned();
        assert_eq!(token.len(), 32);
        assert_ne!(
            token,
            Registry::new(ON).host_token(),
            "one token per launch"
        );

        let (response, accepted) = respond(&registry, None, LABEL, &post(Some(&token), None));
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(accepted.unwrap().widget_id, "clock");

        for (label, token, origin_header) in [
            ("main", Some(token.as_str()), None),
            (LABEL, None, None),
            (LABEL, Some("guess"), None),
            (LABEL, Some(token.as_str()), Some("null")),
        ] {
            let (response, accepted) = respond(&registry, None, label, &post(token, origin_header));
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "{label} {origin_header:?}"
            );
            assert!(accepted.is_none());
        }
        // The token reaches the host only through eval, never in a served resource.
        for path in ["/host/", "/host/host.js", "/clock/1/"] {
            let (page, _) = respond(&registry, None, LABEL, &get(path));
            assert!(
                !String::from_utf8_lossy(page.body()).contains(&token),
                "{path}"
            );
        }
        // An action for a widget that isn't registered is refused.
        let mut spoofed = post(Some(&token), None);
        *spoofed.body_mut() =
            br#"{"widgetId":"timer","message":{"type":"refresh","v":1}}"#.to_vec();
        let (response, accepted) = respond(&registry, None, LABEL, &spoofed);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(accepted.is_none());
    }

    #[test]
    fn a_registered_document_is_never_replaced_and_keeps_its_source() {
        let registry = Registry::new(ON);
        registry
            .register(Source::Builtin, "clock", 1, "<p>a</p>")
            .unwrap();
        for source in [Source::Builtin, Source::Agent, Source::User] {
            assert_eq!(
                registry.register(source, "clock", 1, "<p>b</p>"),
                Err(RegisterError::AlreadyRegistered)
            );
        }
        assert_eq!(registry.source("clock", 1), Some(Source::Builtin));
        assert!(
            registry
                .register(Source::Agent, "clock", 2, "<p>v2</p>")
                .is_ok()
        );
        assert_eq!(registry.source("clock", 2), Some(Source::Agent));
        assert!(registry.has_id("clock") && !registry.has_id("clo"));
        let (page, _) = respond(&registry, None, LABEL, &get("/clock/1/"));
        assert!(String::from_utf8_lossy(page.body()).ends_with("<p>a</p>"));
    }

    #[test]
    fn the_id_host_is_reserved() {
        let registry = Registry::new(ON);
        assert_eq!(
            registry.register(Source::Builtin, "host", 1, "<p>x</p>"),
            Err(RegisterError::BadId)
        );
    }

    #[test]
    fn built_ins_may_not_use_html_sinks_while_preconnect_is_open() {
        let registry = Registry::new(ON);
        for sink in BUILTIN_HTML_SINKS {
            let html = format!("<script>el.{sink} = text</script>");
            assert_eq!(
                registry.register(Source::Builtin, "slack", 1, &html),
                Err(RegisterError::UnsafeBuiltin(sink)),
                "{sink}"
            );
        }
        let safe = "<script>el.textContent = text</script>";
        assert!(registry.register(Source::Builtin, "slack", 1, safe).is_ok());
    }

    #[test]
    fn csps_match_the_architecture() {
        for directive in [
            "default-src 'none'",
            "connect-src 'none'",
            "frame-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
        ] {
            assert!(
                WIDGET_CSP.contains(directive),
                "widget CSP lacks {directive}"
            );
        }
        assert!(!WIDGET_CSP.contains("'self'"));
        assert!(HOST_CSP.contains("frame-src rlxwidget: http://rlxwidget.localhost;"));
        assert!(HOST_CSP.contains("script-src 'self';"));
        assert!(HOST_CSP.contains("connect-src 'self'"));
        assert!(!HOST_CSP.contains('*'));
    }

    #[test]
    fn eval_arguments_are_json_never_interpolated() {
        let hostile = "\"); window.__TAURI_INTERNALS__.invoke('x'); (\"</script>\u{2028}`${1}`";
        let id = Value::String(hostile.to_owned());
        let payload = json!({ "text": hostile, "n": [1, 2] });
        let script = host_call(HostFn::Data, &[id.clone(), payload.clone()]);
        let prefix = "window.__rlxHost.data(";
        assert!(script.starts_with(prefix) && script.ends_with(')'));
        // The argument list is exactly the two JSON values: a JSON array parse of it gives
        // them back, so the hostile string never left its string literal.
        let args = &script[prefix.len()..script.len() - 1];
        let parsed: Value = serde_json::from_str(&format!("[{args}]")).unwrap();
        assert_eq!(parsed, json!([id, payload]));
        assert_eq!(
            host_call(HostFn::Mount, &[json!([])]),
            "window.__rlxHost.mount([])"
        );
    }

    #[test]
    fn navigation_stays_on_the_widget_scheme() {
        let ok = [host_url(), widget_url("clock", 1), "about:blank".to_owned()];
        for url in ok {
            assert!(allow_navigation(&Url::parse(&url).unwrap()), "{url}");
        }
        let blocked = [
            "http://127.0.0.1:8080/",
            "https://example.com/",
            "tauri://localhost/",
            "http://tauri.localhost/",
            "http://ipc.localhost/",
            "ipc://localhost/",
            "rlxwidget://evil/",
            "http://rlxwidget.evil/",
            "rlxwidget://localhost.evil/",
            "data:text/html,hi",
            "javascript:alert(1)",
            "file:///etc/passwd",
        ];
        for url in blocked {
            assert!(!allow_navigation(&Url::parse(url).unwrap()), "{url}");
        }
    }
}
