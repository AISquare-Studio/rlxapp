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
//! isolation probe passes on that OS under `RLX_PROBE_STRICT=1`.
//!
//! | OS | Widgets webview in v0 | Deny-all proxy | Agent-made widgets eligible |
//! | --- | --- | --- | --- |
//! | macOS 14+ | yes | yes, except loopback: on the widgets webview's own non-persistent `WKWebsiteDataStore` (Tauri's `macos-proxy`) | the owner's call: the probe's loopback-preconnect gate can't pass there |
//! | macOS 11-13 | yes, built-ins only | no: WebKit has no per-webview proxy before macOS 14 | no, never |
//! | Windows 10/11 (WebView2) | no; the probe attaches one | yes: the widgets webview's own WebView2 environment and user-data folder, with `--proxy-server` and `--proxy-bypass-list=<-loopback>` | once the product attaches a widgets webview there and the probe passes |
//! | Linux (WebKitGTK) | no: WebKitGTK can't place a child webview | in code: an ephemeral web context with a custom proxy; untested, since nothing attaches | no |
//!
//! On macOS 11-13 the built-ins still render in the widgets webview without a proxy. That is
//! why built-ins set connector text with `textContent` only ([`super::BUILTIN_HTML_SINKS`]).
//!
//! What the proxy doesn't cover:
//! - **Loopback on macOS.** Network.framework never proxies loopback (`127.0.0.1`,
//!   `localhost`), with an HTTP or a SOCKS proxy alike, and has no setting for it. So on macOS
//!   a widget's preconnect can still open an empty TCP connection to a port on this machine,
//!   which only a local process sees. Off-machine names and addresses do go to the proxy.
//!   WebView2 proxies loopback too, given `<-loopback>`.
//! - **DNS** the engine resolves outside its proxy settings (a `dns-prefetch`, say). The
//!   probe can't see it, so that channel is unmeasured.

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
        Os::MacOs(_) => Support::Unavailable("WebKit has no per-webview proxy before macOS 14"),
        Os::Windows | Os::Linux => Support::DenyAll,
    }
}

/// This machine's row of the matrix.
pub fn support() -> Support {
    support_for(this_os())
}

fn this_os() -> Os {
    if cfg!(windows) {
        Os::Windows
    } else if cfg!(target_os = "macos") {
        Os::MacOs(macos_major())
    } else {
        Os::Linux
    }
}

/// macOS's major version, read from SystemVersion.plist: no process to spawn and no FFI.
fn macos_major() -> Option<u32> {
    static MAJOR: OnceLock<Option<u32>> = OnceLock::new();
    *MAJOR.get_or_init(|| {
        std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist")
            .ok()
            .and_then(|plist| product_major(&plist))
    })
}

/// The major version in a SystemVersion.plist's `ProductVersion`: 14 for `14.5`.
pub fn product_major(plist: &str) -> Option<u32> {
    let (_, after_key) = plist.split_once("<key>ProductVersion</key>")?;
    let value = after_key.trim_start().strip_prefix("<string>")?;
    let (version, _) = value.split_once("</string>")?;
    version.split('.').next()?.trim().parse().ok()
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
/// other. Main's arguments are never copied in, so its remote-debugging port (test builds)
/// stays main's alone.
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

/// Accepts every connection and closes it unread, counting each one.
fn refuse_all(listener: &TcpListener, refused: &AtomicUsize) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                drop(stream);
                refused.fetch_add(1, Ordering::Relaxed);
            }
            // Out of descriptors, say: back off rather than spin.
            Err(_) => thread::sleep(Duration::from_millis(50)),
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
        for old in [Some(11), Some(13), None] {
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
    }

    #[test]
    fn reads_the_macos_major_version() {
        let plist = |version: &str| {
            format!(
                "<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n<dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>{version}</string>\n</dict>\n</plist>\n"
            )
        };
        assert_eq!(product_major(&plist("14.5")), Some(14));
        assert_eq!(product_major(&plist("13.6.1")), Some(13));
        assert_eq!(product_major(&plist("26")), Some(26));
        assert_eq!(product_major(&plist("")), None);
        assert_eq!(product_major("<dict></dict>"), None);
        if cfg!(target_os = "macos") {
            assert!(macos_major().is_some_and(|major| major >= 11));
        }
    }

    #[test]
    fn webview2_args_proxy_loopback_too() {
        let args = webview2_args(4321);
        assert!(args.contains("--proxy-server=http://127.0.0.1:4321"));
        assert!(args.contains("--proxy-bypass-list=<-loopback>"));
        assert!(!args.contains("remote-debugging"));
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
