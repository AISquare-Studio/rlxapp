//! The deny-all network proxy for the `widgets` webview (docs/architecture.md §5.3).
//!
//! CSP doesn't govern every connection a page can cause. The isolation probe found that WebKit
//! and WebView2 both open a TCP connection for `<link rel=preconnect>` despite
//! `default-src 'none'`, from the host page and from a sandboxed widget frame. A hostname can
//! carry data, so that is an exfiltration channel. So the widgets webview sends all its
//! network traffic to a proxy this process owns, which refuses everything: it closes each
//! connection unread, so nothing it is asked for is looked up or forwarded. The widget scheme
//! is served in-process by the scheme handler and never reaches a proxy, so widgets still load.
//!
//! The proxy listens on a loopback port the app holds for its whole life, so no other process
//! can take the port and stand in as a working proxy. Only the widgets webview points at it:
//! main keeps its own data store (macOS), web context (Linux) or WebView2 environment
//! (Windows), and none of those has a proxy.
//!
//! # The OS-capability matrix
//! Which OS gets the proxy, and so where agent-made widgets may ever be turned on. They stay
//! off on every OS in v0 ([`super::policy`]). Turning them on is the owner's call, once the
//! isolation probe passes on that OS under `RLX_PROBE_STRICT=1`. Registration also checks
//! this at run time ([`ensure_eligible`]): no agent-made widget registers on a machine
//! without the running proxy, whatever the switch says.
//!
//! | OS | Widgets webview in v0 | Deny-all proxy | Agent-made widgets eligible |
//! | --- | --- | --- | --- |
//! | macOS 14+ | yes | yes, on the widgets webview's own non-persistent `WKWebsiteDataStore` (Tauri's `macos-proxy`), except the residual below | yes, once the probe passes, with the residual shown as a warning ([`Residual::LocalNetwork`]) |
//! | macOS 11-13, or a version that can't be read | yes, built-ins only | no: WebKit has no per-webview proxy before macOS 14 | no, never |
//! | Windows 10/11 (WebView2) | no; the probe attaches one | yes: the widgets webview's own WebView2 environment and user-data folder, with `--proxy-server` and `--proxy-bypass-list=<-loopback>` | once the product attaches a widgets webview there and the probe passes |
//! | Linux (WebKitGTK) | no: WebKitGTK can't place a child webview | in code: an ephemeral web context with a custom proxy; untested, since nothing attaches | no |
//!
//! On macOS 11-13 the built-ins still render in the widgets webview without a proxy. That is
//! why built-ins set connector text with `textContent` only ([`super::BUILTIN_HTML_SINKS`]).
//! The macOS version comes from `NSProcessInfo`, the source wry uses. Under
//! `SYSTEM_VERSION_COMPAT=1` it reads 10.16; that counts as unknown, so not eligible.
//!
//! # What the proxy doesn't cover
//! Measured by the isolation probe on macOS 27.2: each side (the host page and a widget
//! frame) preconnects to every target over `http://` and `https://`, the proxy's test-build
//! log names each `CONNECT` it refused, and a listener on this Mac's own addresses sees each
//! direct connection (src/e2e/reach.rs). CI repeats it on every run, on macOS and Windows.
//! - **macOS 14+: the local network (the owner-accepted residual, warned in the opt-in).**
//!   Network.framework never sends these to a proxy, and has no setting for it:
//!   - **this Mac**: `127.0.0.1`, `localhost`, `::1` and the Mac's own LAN address. An http
//!     preconnect opens an empty TCP connection. An https one sends a standard TLS
//!     ClientHello (4 connections per preconnect), with no SNI for an IP literal and SNI
//!     `localhost` for `localhost`. Nothing page-controlled beyond the port and timing.
//!   - **link-local IPv4 (169.254/16)**, off this Mac on the local network: a direct TCP
//!     connect on the LAN interface (Network.framework's log shows the SYN, retried for
//!     about 11 s). The page picks the address and the port. Nothing answered there in the
//!     measurement; a device that did would get a ClientHello for https, as loopback does.
//!
//!   Everything else goes to the proxy, which refuses it: link-local IPv6 (`fe80::`), ULA
//!   (`fd00::`), RFC 1918 addresses other than this Mac's (off-subnet, and a peer on its own
//!   subnet), `.local` names, `*.localhost` names (so no page-chosen SNI reaches a local
//!   port), TEST-NET addresses and external names. The probe gates on each of those, per side
//!   and target, on macOS too.
//! - **WebRTC, on every OS.** A proxy doesn't govern it. `frames.js` removes it from every
//!   frame of the widgets webview. On Windows the widgets' WebView2 also gets
//!   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, so WebRTC there can only
//!   go through the deny-all proxy; the probe checks it with `frames.js` skipped.
//! - **DNS** the engine resolves outside its proxy settings (a `dns-prefetch`, say). On
//!   macOS 27.2, mDNSResponder resolved none of the widgets' names behind the proxy, only
//!   main's. CI measures it on every run: the probe's zone resolves through its own DNS
//!   listener (`/etc/resolver` on macOS, an NRPT rule on Windows), and each side's names
//!   must get 0 queries.

use std::io;
use std::net::{Ipv4Addr, TcpListener};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

use tauri::Url;

/// Whether an OS gives the widgets webview the deny-all proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    /// The widgets webview runs behind the deny-all proxy.
    DenyAll,
    /// No per-webview proxy on this OS, and why. Agent-made widgets are never eligible here.
    Unavailable(&'static str),
}

impl Support {
    /// As the probe report shows it: `"deny-all"`, or `"unavailable: <reason>"`.
    pub fn describe(self) -> String {
        match self {
            Self::DenyAll => "deny-all".to_owned(),
            Self::Unavailable(reason) => format!("unavailable: {reason}"),
        }
    }
}

/// The rows of the matrix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    /// With the major version, if it could be read.
    MacOs(Option<u32>),
    Windows,
    Linux,
}

/// The first macOS with a per-webview proxy (`WKWebsiteDataStore.proxyConfigurations`).
pub const MACOS_PROXY_MAJOR: u32 = 14;

/// The matrix: whether `os` gets the deny-all proxy. An unknown macOS version gets none,
/// because asking for a proxy on macOS 13 or older crashes WebKit (the API isn't there).
pub const fn support_for(os: Os) -> Support {
    match os {
        Os::MacOs(Some(major)) if major >= MACOS_PROXY_MAJOR => Support::DenyAll,
        Os::MacOs(Some(10)) => Support::Unavailable(
            "macOS reports 10.x (SYSTEM_VERSION_COMPAT), so its real version is unknown",
        ),
        Os::MacOs(Some(_)) => {
            Support::Unavailable("WebKit has no per-webview proxy before macOS 14")
        }
        Os::MacOs(None) => Support::Unavailable("the macOS version couldn't be read"),
        Os::Windows | Os::Linux => Support::DenyAll,
    }
}

/// What the deny-all proxy leaves open where it runs, as the isolation probe measured it (see
/// the module docs). The UI shows it as a warning before anyone opts in to agent-made HTML
/// widgets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Residual {
    /// macOS 14+: a widget can still make the Mac open a TCP connection (and send a standard
    /// TLS ClientHello, for https) to a port on this Mac, or to a link-local IPv4 address
    /// (169.254/16) on the local network.
    LocalNetwork,
}

/// The residual on `os`, where it has the proxy.
pub const fn residual_for(os: Os) -> Option<Residual> {
    match (os, support_for(os)) {
        (Os::MacOs(_), Support::DenyAll) => Some(Residual::LocalNetwork),
        _ => None,
    }
}

/// This machine's row of the matrix.
pub fn support() -> Support {
    support_for(os())
}

/// This machine's OS.
pub fn os() -> Os {
    if cfg!(windows) {
        Os::Windows
    } else if cfg!(target_os = "macos") {
        Os::MacOs(macos_major())
    } else {
        Os::Linux
    }
}

/// macOS's major version, from `NSProcessInfo`: the source wry uses for its own version
/// checks, so the two never disagree.
#[cfg(target_os = "macos")]
fn macos_major() -> Option<u32> {
    let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
    u32::try_from(version.majorVersion)
        .ok()
        .filter(|major| *major > 0)
}

#[cfg(not(target_os = "macos"))]
fn macos_major() -> Option<u32> {
    None
}

/// Whether agent-made widgets may run on `os`: only behind the deny-all proxy, which must be
/// running. Starts it if it hasn't started yet, and returns its port, or why not.
pub fn ensure_eligible(os: Os) -> Result<u16, String> {
    match support_for(os) {
        Support::Unavailable(reason) => Err(reason.to_owned()),
        Support::DenyAll => {
            deny_all().map_err(|error| format!("the deny-all proxy couldn't start: {error}"))
        }
    }
}

/// [`ensure_eligible`] without starting the proxy, for the policy the UI shows. The proxy
/// starts when the widgets webview attaches; until then it counts as able to start, unless
/// it already failed.
pub fn eligibility(os: Os) -> Result<(), String> {
    match (support_for(os), PROXY.get()) {
        (Support::Unavailable(reason), _) => Err(reason.to_owned()),
        (Support::DenyAll, Some(Err(error))) => {
            Err(format!("the deny-all proxy couldn't start: {error}"))
        }
        (Support::DenyAll, _) => Ok(()),
    }
}

/// The proxy's port, once started, or why it couldn't start.
static PROXY: OnceLock<Result<u16, String>> = OnceLock::new();

/// How many connections the proxy has refused (the probe reports it).
static REFUSED: AtomicUsize = AtomicUsize::new(0);

/// Starts the deny-all proxy on first use and returns its port. It runs as long as the app.
pub fn deny_all() -> Result<u16, String> {
    PROXY
        .get_or_init(|| start(&REFUSED).map_err(|error| error.to_string()))
        .clone()
}

/// The running proxy's port, without starting it.
pub fn running() -> Option<u16> {
    PROXY.get().and_then(|started| started.clone().ok())
}

/// How many connections the proxy has refused so far.
pub fn refused() -> usize {
    REFUSED.load(Ordering::Relaxed)
}

/// The proxy as a URL for `WebviewBuilder::proxy_url` (macOS and Linux).
pub fn url(port: u16) -> Url {
    Url::parse(&format!("http://127.0.0.1:{port}")).expect("a loopback URL parses")
}

/// The WebView2 browser arguments of the widgets webview's own environment: wry's defaults
/// plus the proxy. Chromium sends loopback hosts straight past any proxy unless
/// `<-loopback>` removes that rule, and a page can name a loopback host as easily as any
/// other. WebRTC gets no UDP that bypasses the proxy, so it too can reach only the proxy
/// (behind `frames.js`, which removes it). Main's arguments are never copied in, so its
/// remote-debugging port (test builds) stays main's alone.
pub fn webview2_args(port: u16) -> String {
    format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
         --proxy-server=http://127.0.0.1:{port} --proxy-bypass-list=<-loopback> \
         --force-webrtc-ip-handling-policy=disable_non_proxied_udp"
    )
}

/// The widgets webview's own WebView2 user-data folder, under the app's local data folder.
/// A second environment needs its own folder: WebView2 refuses one with other options on a
/// folder that is in use (0x8007139F).
pub const WEBVIEW2_DATA_DIR: &str = "widgets-webview2";

fn start(refused: &'static AtomicUsize) -> io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    thread::Builder::new()
        .name("widgets-deny-all-proxy".into())
        .spawn(move || refuse_all(&listener, refused))?;
    Ok(port)
}

/// Accepts every connection and closes it unread, counting each one. Test builds read what
/// it asked for first ([`log`]), and still answer nothing.
fn refuse_all(listener: &TcpListener, refused: &AtomicUsize) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                refused.fetch_add(1, Ordering::Relaxed);
                #[cfg(feature = "e2e")]
                e2e::record(stream);
                #[cfg(not(feature = "e2e"))]
                drop(stream);
            }
            // Out of descriptors, say: back off rather than spin.
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// What each refused connection asked for, timestamped: `"<unix ms> <first line>"`, or
/// `"<unix ms> no data"`. Test builds only: the probe matches a `CONNECT <authority>` (or an
/// absolute-form request) to the preconnect that caused it.
#[cfg(feature = "e2e")]
pub fn log() -> Vec<String> {
    e2e::LOG
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[cfg(feature = "e2e")]
mod e2e {
    use std::io::Read;
    use std::net::TcpStream;
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    pub static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

    /// Reads the first line on its own thread (so a silent connection holds up no other),
    /// records it, and closes without a reply.
    pub fn record(mut stream: TcpStream) {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let _ = thread::Builder::new()
            .name("widgets-deny-all-proxy-e2e".into())
            .spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
                let mut buffer = [0u8; 1024];
                let n = stream.read(&mut buffer).unwrap_or(0);
                let line = first_line(&buffer[..n]);
                LOG.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(format!("{at} {line}"));
            });
    }

    /// `"no data"`, the first line if it is text, or `"<n> bytes"`.
    pub fn first_line(data: &[u8]) -> String {
        if data.is_empty() {
            return "no data".to_owned();
        }
        let line = data
            .split(|b| *b == b'\r' || *b == b'\n')
            .next()
            .unwrap_or_default();
        if !line.is_empty() && line.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
            String::from_utf8_lossy(line).into_owned()
        } else {
            format!("{} bytes", data.len())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Instant;

    #[test]
    fn the_matrix() {
        assert_eq!(support_for(Os::MacOs(Some(14))), Support::DenyAll);
        assert_eq!(support_for(Os::MacOs(Some(26))), Support::DenyAll);
        // 10 is what macOS 11+ reports under SYSTEM_VERSION_COMPAT=1.
        for old in [Some(10), Some(11), Some(13), None] {
            assert!(
                matches!(support_for(Os::MacOs(old)), Support::Unavailable(_)),
                "{old:?}"
            );
            assert_eq!(residual_for(Os::MacOs(old)), None);
        }
        assert_eq!(support_for(Os::Windows), Support::DenyAll);
        assert_eq!(support_for(Os::Linux), Support::DenyAll);
        assert_eq!(Support::DenyAll.describe(), "deny-all");
        assert!(
            support_for(Os::MacOs(Some(13)))
                .describe()
                .starts_with("unavailable: ")
        );
        assert_eq!(
            residual_for(Os::MacOs(Some(14))),
            Some(Residual::LocalNetwork)
        );
        assert_eq!(residual_for(Os::Windows), None);
        assert_eq!(
            serde_json::to_value(Residual::LocalNetwork).unwrap(),
            "local-network"
        );
    }

    #[test]
    fn only_a_machine_with_the_proxy_is_eligible() {
        for os in [Os::MacOs(Some(13)), Os::MacOs(Some(10)), Os::MacOs(None)] {
            assert!(ensure_eligible(os).is_err(), "{os:?}");
            assert!(eligibility(os).is_err(), "{os:?}");
        }
        let port = ensure_eligible(Os::MacOs(Some(14))).unwrap();
        assert_eq!(running(), Some(port));
        assert_eq!(eligibility(Os::MacOs(Some(14))), Ok(()));
    }

    #[test]
    fn reads_the_macos_version_where_wry_does() {
        if cfg!(target_os = "macos") {
            assert!(macos_major().is_some_and(|major| major >= 11));
            assert!(matches!(os(), Os::MacOs(Some(_))));
        } else {
            assert_eq!(macos_major(), None);
        }
    }

    #[test]
    fn webview2_args_proxy_loopback_and_webrtc_too() {
        let args = webview2_args(4321);
        let args: Vec<&str> = args.split_whitespace().collect();
        for arg in [
            "--proxy-server=http://127.0.0.1:4321",
            "--proxy-bypass-list=<-loopback>",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ] {
            assert!(args.contains(&arg), "{arg}");
        }
        assert!(!args.iter().any(|arg| arg.contains("remote-debugging")));
        assert_eq!(url(4321).as_str(), "http://127.0.0.1:4321/");
    }

    #[test]
    fn refuses_every_connection_unread() {
        let refused: &'static AtomicUsize = Box::leak(Box::new(AtomicUsize::new(0)));
        let port = start(refused).unwrap();
        for request in [
            "CONNECT exfil.example:443 HTTP/1.1\r\nHost: exfil.example:443\r\n\r\n",
            "GET http://exfil.example/ HTTP/1.1\r\nHost: exfil.example\r\n\r\n",
            "",
        ] {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let _ = stream.write_all(request.as_bytes());
            let mut reply = Vec::new();
            // A close (0 bytes) or a reset: either way, nothing comes back.
            let _ = stream.read_to_end(&mut reply);
            assert!(reply.is_empty(), "{request:?} got {reply:?}");
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while refused.load(Ordering::Relaxed) < 3 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(refused.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn the_app_proxy_starts_once() {
        let port = deny_all().unwrap();
        assert_eq!(deny_all().unwrap(), port);
        assert_eq!(running(), Some(port));
    }
}
