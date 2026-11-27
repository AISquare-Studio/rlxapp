//! A local listener that records every connection and datagram it gets.
//!
//! The probe aims every widget-side network attempt (fetch, XHR, WebSocket, EventSource,
//! beacons, images, preconnect, RTCPeerConnection's STUN/TURN, navigation) at one of these. A
//! TCP listener and a UDP socket share the port, so both TCP and STUN/TURN-over-UDP land here.

use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, TcpListener, TcpStream, UdpSocket};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub struct Listener {
    pub port: u16,
    hits: Arc<Mutex<Vec<String>>>,
}

impl Listener {
    /// Binds TCP and UDP on 127.0.0.1 with the same free port.
    pub fn start(name: &'static str) -> io::Result<Self> {
        let (tcp, udp) = bind_pair()?;
        let port = tcp.local_addr()?.port();
        let hits = Arc::new(Mutex::new(Vec::new()));

        accept_tcp(name, tcp, Arc::clone(&hits), false)?;

        let udp_hits = Arc::clone(&hits);
        thread::Builder::new()
            .name(format!("e2e-{name}-udp"))
            .spawn(move || {
                let mut buffer = [0u8; 2048];
                while let Ok((n, _)) = udp.recv_from(&mut buffer) {
                    let hit = format!("udp {n} bytes{}", stun_note(&buffer[..n]));
                    push(&udp_hits, now_ms(), hit);
                }
            })?;

        Ok(Self { port, hits })
    }

    /// A TCP listener for a side's on-host reach targets (see reach.rs): two ports, one for
    /// its http targets and one for its https targets, so each on-host attempt has an
    /// authority of its own in the proxy's log. Each is bound on 127.0.0.1, [::1] and `lan`
    /// wherever it can be, and each hit names the address it arrived on: `tcp@<ip> …`.
    /// Returns the listener (its `port` is the http one), the https port and the addresses it
    /// bound.
    pub fn start_reach(
        name: &'static str,
        lan: Option<IpAddr>,
    ) -> io::Result<(Self, u16, Vec<String>)> {
        let hits = Arc::new(Mutex::new(Vec::new()));
        let mut ports = [0u16; 2];
        let mut bound = Vec::new();
        for port in &mut ports {
            let first = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
            *port = first.local_addr()?.port();
            accept_tcp(name, first, Arc::clone(&hits), true)?;
            bound.push(format!("127.0.0.1:{port}"));
            for ip in std::iter::once(IpAddr::V6(Ipv6Addr::LOCALHOST)).chain(lan) {
                if let Ok(tcp) = TcpListener::bind((ip, *port)) {
                    accept_tcp(name, tcp, Arc::clone(&hits), true)?;
                    bound.push(std::net::SocketAddr::new(ip, *port).to_string());
                }
            }
        }
        Ok((
            Self {
                port: ports[0],
                hits,
            },
            ports[1],
            bound,
        ))
    }

    /// Connects over TCP and sends one datagram, waits for both to be recorded, then clears
    /// them. Returns whether the listener saw both: the positive control for "0 connections".
    pub fn self_test(&self) -> bool {
        let tcp = TcpStream::connect((Ipv4Addr::LOCALHOST, self.port))
            .and_then(|mut stream| stream.write_all(b"SELFTEST /tcp\r\n\r\n"));
        let udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
            .and_then(|socket| socket.send_to(b"SELFTEST", (Ipv4Addr::LOCALHOST, self.port)));
        let deadline = Instant::now() + Duration::from_secs(3);
        let ok = tcp.is_ok()
            && udp.is_ok()
            && loop {
                let hits = self.hits();
                let seen = |prefix: &str| hits.iter().any(|h| untimed(h).starts_with(prefix));
                if seen("tcp SELFTEST") && seen("udp ") {
                    break true;
                }
                if Instant::now() > deadline {
                    break false;
                }
                thread::sleep(Duration::from_millis(20));
            };
        self.clear();
        ok
    }

    pub fn hits(&self) -> Vec<String> {
        self.hits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn clear(&self) {
        self.hits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

/// Records a hit, prefixed with its Unix time in ms so the runner can line it up with the
/// probe's attempts.
fn push(hits: &Mutex<Vec<String>>, at: u128, hit: String) {
    hits.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(format!("{at} {hit}"));
}

/// A hit without its timestamp.
fn untimed(hit: &str) -> &str {
    hit.split_once(' ').map_or(hit, |(_, rest)| rest)
}

fn bind_pair() -> io::Result<(TcpListener, UdpSocket)> {
    let mut last = None;
    for _ in 0..20 {
        let tcp = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = tcp.local_addr()?.port();
        match UdpSocket::bind((Ipv4Addr::LOCALHOST, port)) {
            Ok(udp) => return Ok((tcp, udp)),
            Err(error) => last = Some(error),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("no free port pair")))
}

/// Accepts on its own thread. Each connection is stamped at accept and read on a thread of
/// its own, so one silent connection (a preconnect) doesn't delay the next.
fn accept_tcp(
    name: &'static str,
    tcp: TcpListener,
    hits: Arc<Mutex<Vec<String>>>,
    tag_address: bool,
) -> io::Result<()> {
    thread::Builder::new()
        .name(format!("e2e-{name}-tcp"))
        .spawn(move || {
            for stream in tcp.incoming().flatten() {
                let at = now_ms();
                let hits = Arc::clone(&hits);
                let address = tag_address
                    .then(|| stream.local_addr().ok().map(|a| a.ip()))
                    .flatten();
                thread::spawn(move || {
                    let hit = describe_tcp(stream);
                    let hit = match address {
                        Some(ip) => format!("tcp@{ip}{}", &hit["tcp".len()..]),
                        None => hit,
                    };
                    push(&hits, at, hit);
                });
            }
        })?;
    Ok(())
}

/// Records the request line of a TCP connection, a TLS ClientHello's SNI, or that it sent
/// nothing, then closes it with an empty 204, so nothing a widget asked for comes back.
fn describe_tcp(mut stream: TcpStream) -> String {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
    let mut buffer = vec![0u8; 16 * 1024];
    let mut n = stream.read(&mut buffer).unwrap_or(0);
    // A ClientHello can span reads (Chromium's runs past 1 KB); read the whole record.
    while n > 0 && buffer[0] == 0x16 && n < tls_record_end(&buffer[..n]).min(buffer.len()) {
        match stream.read(&mut buffer[n..]) {
            Ok(0) | Err(_) => break,
            Ok(more) => n += more,
        }
    }
    let _ = stream
        .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    let _ = stream.shutdown(Shutdown::Both);
    let data = &buffer[..n];
    if data.is_empty() {
        return "tcp connection, no data".to_owned();
    }
    if let Some(sni) = client_hello_sni(data) {
        return format!("tcp tls ClientHello, {sni}");
    }
    let first_line = data
        .split(|b| *b == b'\r' || *b == b'\n')
        .next()
        .unwrap_or_default();
    if first_line
        .iter()
        .all(|b| b.is_ascii_graphic() || *b == b' ')
        && !first_line.is_empty()
    {
        format!("tcp {}", String::from_utf8_lossy(first_line))
    } else {
        format!("tcp {n} bytes{}", stun_note(data))
    }
}

/// Where the first TLS record ends (5-byte header plus its length), or 5 if unknown yet.
fn tls_record_end(data: &[u8]) -> usize {
    match data {
        [_, _, _, high, low, ..] => 5 + ((*high as usize) << 8 | *low as usize),
        _ => 5,
    }
}

/// If `data` starts with a TLS ClientHello: `"sni=<name>"`, `"no sni"`, or
/// `"sni not in the first record"`. None for anything else.
fn client_hello_sni(data: &[u8]) -> Option<String> {
    if data.len() < 6 || data[0] != 0x16 || data[1] != 0x03 || data[5] != 0x01 {
        return None;
    }
    let end = tls_record_end(data).min(data.len());
    let body = &data[5..end];
    let found = (|| {
        let mut at = 4 + 2 + 32; // handshake header, version, random
        let byte = |at: usize| body.get(at).copied().map(usize::from);
        let pair = |at: usize| Some(byte(at)? << 8 | byte(at + 1)?);
        at += 1 + byte(at)?; // session id
        at += 2 + pair(at)?; // cipher suites
        at += 1 + byte(at)?; // compression methods
        let extensions_end = (at + 2 + pair(at)?).min(body.len());
        at += 2;
        while at + 4 <= extensions_end {
            let (kind, len) = (pair(at)?, pair(at + 2)?);
            if kind == 0 {
                // server_name: list length (2), name type (1), name length (2), name
                let name_len = pair(at + 4 + 3)?;
                let name = body.get(at + 4 + 5..at + 4 + 5 + name_len)?;
                return Some(Some(String::from_utf8_lossy(name).into_owned()));
            }
            at += 4 + len;
        }
        Some(None)
    })();
    Some(match found {
        Some(Some(name)) => format!("sni={name}"),
        Some(None) if tls_record_end(data) <= data.len() => "no sni".to_owned(),
        _ => "sni not in the first record".to_owned(),
    })
}

/// STUN and TURN messages carry the magic cookie 0x2112A442 at bytes 4..8 (RFC 5389); over
/// TCP, TURN frames the same message.
fn stun_note(data: &[u8]) -> &'static str {
    if data.len() >= 8 && data[4..8] == [0x21, 0x12, 0xA4, 0x42] {
        " (STUN/TURN)"
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal ClientHello: no cipher suites or compression to speak of, and the given
    /// extensions.
    fn client_hello(extensions: &[u8]) -> Vec<u8> {
        let mut body = vec![0x03, 0x03];
        body.extend([7u8; 32]); // random
        body.push(0); // session id
        body.extend([0, 2, 0x13, 0x01]); // one cipher suite
        body.extend([1, 0]); // null compression
        body.extend((extensions.len() as u16).to_be_bytes());
        body.extend(extensions);
        let mut handshake = vec![0x01, 0, (body.len() >> 8) as u8, body.len() as u8];
        handshake.extend(body);
        let mut record = vec![0x16, 0x03, 0x01];
        record.extend((handshake.len() as u16).to_be_bytes());
        record.extend(handshake);
        record
    }

    fn sni(name: &str) -> Vec<u8> {
        let mut ext = vec![0, 0];
        let list_len = 3 + name.len();
        ext.extend(((list_len + 2) as u16).to_be_bytes());
        ext.extend((list_len as u16).to_be_bytes());
        ext.push(0);
        ext.extend((name.len() as u16).to_be_bytes());
        ext.extend(name.as_bytes());
        ext
    }

    #[test]
    fn reads_the_sni_of_a_client_hello() {
        // Another extension first, as Chromium may order them.
        let mut extensions = vec![0x00, 0x2b, 0, 3, 2, 0x03, 0x04];
        extensions.extend(sni("data.example.localhost"));
        let hello = client_hello(&extensions);
        assert_eq!(
            client_hello_sni(&hello).as_deref(),
            Some("sni=data.example.localhost")
        );
        assert_eq!(
            client_hello_sni(&client_hello(&[])).as_deref(),
            Some("no sni")
        );
        assert_eq!(
            client_hello_sni(&hello[..60]).as_deref(),
            Some("sni not in the first record")
        );
        assert_eq!(client_hello_sni(b"GET / HTTP/1.1\r\n"), None);
        assert_eq!(client_hello_sni(&[0x16, 0x03]), None);
    }

    #[test]
    fn a_reach_listener_names_the_address_and_the_sni() {
        let (listener, tls_port, bound) = Listener::start_reach("reach-test", None).unwrap();
        assert_ne!(tls_port, listener.port);
        assert_eq!(bound[0], format!("127.0.0.1:{}", listener.port));
        assert!(bound.contains(&format!("127.0.0.1:{tls_port}")));
        let mut extensions = Vec::new();
        extensions.extend(sni("probe.localhost"));
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, tls_port)).unwrap();
        stream.write_all(&client_hello(&extensions)).unwrap();
        let _ = stream.read_to_end(&mut Vec::new());
        let deadline = Instant::now() + Duration::from_secs(3);
        while listener.hits().is_empty() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let hits: Vec<String> = listener
            .hits()
            .iter()
            .map(|h| untimed(h).to_owned())
            .collect();
        assert_eq!(hits, ["tcp@127.0.0.1 tls ClientHello, sni=probe.localhost"]);
    }

    #[test]
    fn records_tcp_request_lines_and_datagrams() {
        let listener = Listener::start("test").unwrap();
        assert!(listener.self_test());
        assert!(listener.hits().is_empty(), "self-test hits are cleared");

        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, listener.port)).unwrap();
        stream
            .write_all(b"GET /widget-iframe/fetch HTTP/1.1\r\nHost: x\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        assert!(response.starts_with("HTTP/1.1 204"));

        let mut stun = vec![0u8, 1, 0, 0, 0x21, 0x12, 0xA4, 0x42];
        stun.extend_from_slice(&[0u8; 12]);
        UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .send_to(&stun, (Ipv4Addr::LOCALHOST, listener.port))
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        while listener.hits().len() < 2 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let mut hits: Vec<String> = listener
            .hits()
            .iter()
            .map(|h| untimed(h).to_owned())
            .collect();
        hits.sort();
        assert_eq!(
            hits,
            [
                "tcp GET /widget-iframe/fetch HTTP/1.1",
                "udp 20 bytes (STUN/TURN)"
            ]
        );
    }
}
