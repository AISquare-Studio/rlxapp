//! A local listener that records every connection and datagram it gets.
//!
//! The probe aims every widget-side network attempt (fetch, XHR, WebSocket, EventSource,
//! beacons, images, preconnect, RTCPeerConnection's STUN/TURN, navigation) at one of these. A
//! TCP listener and a UDP socket share the port, so both TCP and STUN/TURN-over-UDP land here.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream, UdpSocket};
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

        let tcp_hits = Arc::clone(&hits);
        thread::Builder::new()
            .name(format!("e2e-{name}-tcp"))
            .spawn(move || {
                for stream in tcp.incoming().flatten() {
                    // Stamped at accept, and read on its own thread, so one silent
                    // connection (a preconnect) doesn't delay the next.
                    let at = now_ms();
                    let hits = Arc::clone(&tcp_hits);
                    thread::spawn(move || push(&hits, at, describe_tcp(stream)));
                }
            })?;

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

/// Records the request line of a TCP connection (or that it sent nothing), then closes it
/// with an empty 204, so nothing a widget asked for comes back.
fn describe_tcp(mut stream: TcpStream) -> String {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
    let mut buffer = [0u8; 1024];
    let n = stream.read(&mut buffer).unwrap_or(0);
    let _ = stream
        .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    let _ = stream.shutdown(Shutdown::Both);
    let data = &buffer[..n];
    if data.is_empty() {
        return "tcp connection, no data".to_owned();
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
