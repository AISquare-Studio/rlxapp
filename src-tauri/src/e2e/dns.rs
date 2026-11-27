//! The probe's DNS listener: does a widget's hostname reach a resolver, outside the deny-all
//! proxy?
//!
//! CI routes the probe's own zone, [`ZONE`], to this listener: `/etc/resolver/<zone>` on
//! macOS, an NRPT rule on Windows. The port comes from [`ENV_PORT`]: CI sets it to match the
//! route (Windows' NRPT can only name port 53). Unset, there is no listener and the probe
//! leaves DNS unmeasured: the plans then name nothing in the zone, so a local run sends no
//! query anywhere.
//!
//! Every query is recorded as `"<unix ms> <type> <name>"` and answered NXDOMAIN, so nothing
//! connects afterwards. Main's names in the zone are the positive control: main isn't behind
//! the proxy, so its preconnect must be looked up here.

use std::io;
use std::net::{Ipv4Addr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

/// The zone the probe's DNS targets live in. `.test` names are never special to a resolver
/// (RFC 6761), unlike `.invalid`, which resolvers answer locally.
pub const ZONE: &str = "rlx-probe-dns.test";

/// The UDP port of the listener, on 127.0.0.1.
pub const ENV_PORT: &str = "RLXAPP_E2E_DNS_PORT";

/// The port CI asked for, if any.
pub fn port_from_env() -> Option<u16> {
    std::env::var(ENV_PORT).ok()?.trim().parse().ok()
}

pub struct DnsListener {
    pub port: u16,
    queries: Arc<Mutex<Vec<String>>>,
}

impl DnsListener {
    pub fn start(port: u16) -> io::Result<Self> {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, port))?;
        let port = socket.local_addr()?.port();
        let queries = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&queries);
        thread::Builder::new()
            .name("e2e-dns".into())
            .spawn(move || {
                let mut buffer = [0u8; 1500];
                loop {
                    let Ok((n, from)) = socket.recv_from(&mut buffer) else {
                        continue;
                    };
                    let packet = &buffer[..n];
                    let at = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or_default();
                    let entry = match question(packet) {
                        Some((name, kind, end)) => {
                            let _ = socket.send_to(&nxdomain(packet, end), from);
                            format!("{at} {} {name}", type_name(kind))
                        }
                        None => format!("{at} unparsed ({n} bytes)"),
                    };
                    log.lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push(entry);
                }
            })?;
        Ok(Self { port, queries })
    }

    pub fn queries(&self) -> Vec<String> {
        self.queries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// The first question of a DNS query: its name (lowercase, no trailing dot), its type and
/// where the question ends.
pub fn question(packet: &[u8]) -> Option<(String, u16, usize)> {
    let questions = u16::from_be_bytes([*packet.get(4)?, *packet.get(5)?]);
    if questions == 0 {
        return None;
    }
    let mut at = 12;
    let mut labels = Vec::new();
    loop {
        let len = usize::from(*packet.get(at)?);
        at += 1;
        if len == 0 {
            break;
        }
        // Queries don't compress names; anything else is malformed here.
        if len > 63 {
            return None;
        }
        let label = packet.get(at..at + len)?;
        labels.push(String::from_utf8_lossy(label).to_ascii_lowercase());
        at += len;
    }
    let kind = u16::from_be_bytes([*packet.get(at)?, *packet.get(at + 1)?]);
    packet.get(at + 2..at + 4)?;
    Some((labels.join("."), kind, at + 4))
}

/// An NXDOMAIN answer to `query`, whose first question ends at `end`.
pub fn nxdomain(query: &[u8], end: usize) -> Vec<u8> {
    let mut answer = Vec::with_capacity(end);
    answer.extend_from_slice(&query[..2]); // ID
    // QR, the query's opcode and RD, AA; then RA and RCODE 3 (NXDOMAIN).
    answer.push(0x80 | (query[2] & 0x79) | 0x04);
    answer.push(0x80 | 0x03);
    answer.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 0]);
    answer.extend_from_slice(&query[12..end]);
    answer
}

fn type_name(kind: u16) -> String {
    match kind {
        1 => "A".into(),
        28 => "AAAA".into(),
        65 => "HTTPS".into(),
        other => format!("type{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn query(id: u16, name: &str, kind: u16) -> Vec<u8> {
        let mut packet = id.to_be_bytes().to_vec();
        packet.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
        for label in name.split('.') {
            packet.push(label.len() as u8);
            packet.extend_from_slice(label.as_bytes());
        }
        packet.push(0);
        packet.extend_from_slice(&kind.to_be_bytes());
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet
    }

    #[test]
    fn reads_the_question_and_answers_nxdomain() {
        let packet = query(0xbeef, "Widget-Iframe.rlx-probe-dns.test", 28);
        let (name, kind, end) = question(&packet).unwrap();
        assert_eq!(name, "widget-iframe.rlx-probe-dns.test");
        assert_eq!(kind, 28);
        assert_eq!(end, packet.len());
        let answer = nxdomain(&packet, end);
        assert_eq!(&answer[..2], &[0xbe, 0xef]);
        assert_eq!(answer[2] & 0x80, 0x80, "a response");
        assert_eq!(answer[3] & 0x0f, 3, "NXDOMAIN");
        assert_eq!(&answer[12..], &packet[12..]);
        assert_eq!(question(&packet[..packet.len() - 1]), None);
        assert_eq!(question(&[0u8; 12]), None);
    }

    #[test]
    fn the_listener_records_each_query() {
        let listener = DnsListener::start(0).unwrap();
        let client = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client
            .send_to(
                &query(7, "main.rlx-probe-dns.test", 1),
                (Ipv4Addr::LOCALHOST, listener.port),
            )
            .unwrap();
        let mut buffer = [0u8; 512];
        let (n, _) = client.recv_from(&mut buffer).unwrap();
        assert_eq!(buffer[3] & 0x0f, 3);
        assert!(n > 12);
        let deadline = Instant::now() + Duration::from_secs(5);
        while listener.queries().is_empty() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let queries = listener.queries();
        assert_eq!(queries.len(), 1);
        assert!(
            queries[0].ends_with(" A main.rlx-probe-dns.test"),
            "{queries:?}"
        );
    }
}
