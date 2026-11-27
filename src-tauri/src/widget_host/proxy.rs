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
//! Which OS gets the proxy, and where agent-made HTML widgets ("Custom HTML widgets") may
//! ever be turned on. They stay off on every OS in v0 ([`super::policy`]). Turning them on is
//! the owner's call, once the isolation probe passes on that OS under `RLX_PROBE_STRICT=1`.
//! Registration also checks this at run time ([`ensure_eligible`]): no agent-made widget
//! registers on a machine that isn't eligible, whatever the switch says.
//!
//! | OS | Widgets webview in v0 | Deny-all proxy | Agent-made HTML widgets eligible |
//! | --- | --- | --- | --- |
//! | macOS 14+ | yes, built-ins only | yes, on the widgets webview's own non-persistent `WKWebsiteDataStore` (Tauri's `macos-proxy`), except the residual below | **no** (the owner's decision): WebKit resolves `dns-prefetch` names outside the proxy ([`Residual::DnsPrefetchLeak`]). Declarative widgets only, until rlx can turn DNS prefetching off for the widgets webview through a supported, safe path |
//! | macOS 11-13, or a version that can't be read | yes, built-ins only | no: WebKit has no per-webview proxy before macOS 14 | no, never |
//! | Windows 10/11 (WebView2) | no; the probe attaches one | yes: the widgets webview's own WebView2 environment and user-data folder, with `--proxy-server` and `--proxy-bypass-list=<-loopback>` | yes, once the product attaches a widgets webview there and the probe passes strict |
//! | Linux (WebKitGTK) | no: WebKitGTK can't place a child webview | in code: an ephemeral web context with a custom proxy; untested, since nothing attaches | no |
//!
//! On macOS 11-13 the built-ins still render in the widgets webview without a proxy. That is
//! why built-ins set connector text with `textContent` only ([`super::BUILTIN_HTML_SINKS`]).
//! The macOS version comes from `NSProcessInfo`, the source wry uses. Under
//! `SYSTEM_VERSION_COMPAT=1` it reads 10.16; that counts as unknown, so not eligible.
//!
//! # What the proxy doesn't cover
//! Measured by the isolation probe on macOS 27.2 and on every CI run (macOS 26.7 and
//! Windows): each side (the host page and a widget frame) preconnects to every target over
//! `http://` and `https://`, the proxy's test-build log names each `CONNECT` it refused, a
//! listener on this host's own addresses sees each direct connection, and a DNS listener sees
//! each lookup of the probe's zone (src/e2e/reach.rs, dns.rs).
//! - **macOS: DNS prefetch (why macOS isn't eligible).** WebKit resolves a
//!   `<link rel=dns-prefetch>` name through the system resolver, outside the proxy: on
//!   macOS 26.7.2 (CI) each side's prefetch name was looked up (A and AAAA). So a widget can
//!   put data in a DNS name that reaches the internet's resolvers. Preconnect names are not
//!   looked up: they go to the proxy as a `CONNECT`. WebKit has a setting for DNS prefetching,
//!   but no public API reaches it (a private `WKPreferences` key, which needs `unsafe` code
//!   this crate forbids). macOS 27.2 is unmeasured by the DNS listener (a local route needs
//!   root); an mDNSResponder log check there saw no widget names.
//! - **macOS 14+: the local network.** Network.framework never sends these to a proxy, and
//!   has no setting for it (the owner accepted this residual before the DNS finding):
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
//! - **WebRTC, on every OS.** A proxy doesn't govern it, so `frames.js`, which removes it from
//!   every frame of the widgets webview, is its only barrier. Measured on Windows with
//!   `frames.js` skipped (the probe's WebRTC-kept run): TURN over TCP goes to the proxy, but
//!   STUN/TURN over UDP reaches a loopback listener directly. WebView2 ignores
//!   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (tried and measured), so the
//!   widgets' WebView2 doesn't get it.
//! - **Windows: nothing measured gets past it.** Behind the proxy the widgets' preconnects
//!   produced nothing anywhere in CI: no `CONNECT` at the proxy (WebView2 appears to drop
//!   them), no direct connection to this host, no TCP connection attempt off it (a `netstat`
//!   witness, whose positive control is main's direct attempt to its own TEST-NET address),
//!   and no DNS lookup (an NRPT rule routes the probe's zone to its listener). The probe gates
//!   on each pair: in the proxy's log, or seen by nothing at all.

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

/// What the deny-all proxy leaves open on an OS, as the isolation probe measured it (see the
/// module docs), for the UI to explain why Custom HTML widgets aren't available there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Residual {
    /// macOS (every version): WebKit resolves `dns-prefetch` names outside the proxy, so a
    /// widget can put data in a DNS name that reaches the internet's resolvers.
    DnsPrefetchLeak,
}

/// The residual on `os`.
pub const fn residual_for(os: Os) -> Option<Residual> {
    match os {
        Os::MacOs(_) => Some(Residual::DnsPrefetchLeak),
        Os::Windows | Os::Linux => None,
    }
}

/// Why macOS isn't eligible even with the proxy (the owner's decision on the measured leak).
pub const MACOS_DNS_PREFETCH: &str = "WebKit resolves dns-prefetch names outside the deny-all proxy (measured on macOS 26.7), so macOS gets declarative widgets only";

/// The matrix's last column: whether agent-made HTML widgets may ever run on `os`. Only
/// behind the deny-all proxy, and never on macOS while WebKit's DNS prefetch leaks.
pub const fn eligibility_for(os: Os) -> Result<(), &'static str> {
    match (os, support_for(os)) {
        (_, Support::Unavailable(reason)) => Err(reason),
        (Os::MacOs(_), Support::DenyAll) => Err(MACOS_DNS_PREFETCH),
        (Os::Windows | Os::Linux, Support::DenyAll) => Ok(()),
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

/// Whether agent-made widgets may run on `os` ([`eligibility_for`]), with the deny-all proxy
/// running. Starts it if it hasn't started yet, and returns its port, or why not.
pub fn ensure_eligible(os: Os) -> Result<u16, String> {
    eligibility_for(os)?;
    deny_all().map_err(|error| format!("the deny-all proxy couldn't start: {error}"))
}

/// [`ensure_eligible`] without starting the proxy, for the policy the UI shows. The proxy
/// starts when the widgets webview attaches; until then it counts as able to start, unless
/// it already failed.
pub fn eligibility(os: Os) -> Result<(), String> {
    eligibility_for(os)?;
    match PROXY.get() {
        Some(Err(error)) => Err(format!("the deny-all proxy couldn't start: {error}")),
        _ => Ok(()),
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
/// other. No WebRTC policy: WebView2 ignores `--force-webrtc-ip-handling-policy` (measured;
/// see the module docs), so `frames.js` is WebRTC's barrier. Main's arguments are never
/// copied in, so its remote-debugging port (test builds) stays main's alone.
pub fn webview2_args(port: u16) -> String {
    format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
         --proxy-server=http://127.0.0.1:{port} --proxy-bypass-list=<-loopback>"
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
        }
        assert_eq!(support_for(Os::Windows), Support::DenyAll);
        assert_eq!(support_for(Os::Linux), Support::DenyAll);
        assert_eq!(Support::DenyAll.describe(), "deny-all");
        assert!(
            support_for(Os::MacOs(Some(13)))
                .describe()
                .starts_with("unavailable: ")
        );
        // The DNS-prefetch leak is macOS's on every version; Windows has none measured.
        for os in [
            Os::MacOs(Some(13)),
            Os::MacOs(Some(14)),
            Os::MacOs(Some(27)),
            Os::MacOs(None),
        ] {
            assert_eq!(residual_for(os), Some(Residual::DnsPrefetchLeak), "{os:?}");
        }
        assert_eq!(residual_for(Os::Windows), None);
        assert_eq!(residual_for(Os::Linux), None);
        assert_eq!(
            serde_json::to_value(Residual::DnsPrefetchLeak).unwrap(),
            "dns-prefetch-leak"
        );
    }

    /// The owner's decision on the measured DNS-prefetch leak: no macOS is eligible, with or
    /// without the proxy. Windows is, behind the running proxy.
    #[test]
    fn only_windows_and_linux_behind_the_proxy_are_eligible() {
        for os in [Os::MacOs(Some(13)), Os::MacOs(Some(10)), Os::MacOs(None)] {
            assert!(ensure_eligible(os).is_err(), "{os:?}");
            assert!(eligibility(os).is_err(), "{os:?}");
        }
        for os in [
            Os::MacOs(Some(14)),
            Os::MacOs(Some(26)),
            Os::MacOs(Some(27)),
        ] {
            assert_eq!(eligibility_for(os), Err(MACOS_DNS_PREFETCH), "{os:?}");
            assert_eq!(ensure_eligible(os), Err(MACOS_DNS_PREFETCH.to_owned()));
            assert_eq!(eligibility(os), Err(MACOS_DNS_PREFETCH.to_owned()));
        }
        let port = ensure_eligible(Os::Windows).unwrap();
        assert_eq!(running(), Some(port));
        assert_eq!(eligibility(Os::Windows), Ok(()));
        assert_eq!(eligibility_for(Os::Linux), Ok(()));
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
    fn webview2_args_proxy_loopback_too() {
        let args = webview2_args(4321);
        let args: Vec<&str> = args.split_whitespace().collect();
        for arg in [
            "--proxy-server=http://127.0.0.1:4321",
            "--proxy-bypass-list=<-loopback>",
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
