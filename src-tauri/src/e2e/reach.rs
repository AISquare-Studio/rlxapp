//! The reach plan: where each side preconnects, so the probe can tell which destinations
//! the widgets webview's deny-all proxy covers and which go past it.
//!
//! Every target is tried over `http://` and `https://` (an https preconnect may send a TLS
//! ClientHello, with SNI for a name). The proxy's test-build log ([`crate::widget_host::proxy::log`])
//! shows each `CONNECT <authority>` it refused; a side's reach listener (bound on 127.0.0.1,
//! [::1] and this host's LAN address) shows each direct connection to this host.
//! - **on-host**: loopback, `localhost`, a `*.localhost` name and this host's LAN address.
//!   On macOS, loopback, `localhost` and the LAN address are the owner-accepted residual
//!   (Network.framework never proxies them), so they're measured; the `*.localhost` name, and
//!   every on-host target elsewhere, must reach only the proxy.
//! - **off-host**: link-local IPv4 and IPv6, a peer on this host's /24, RFC 1918 addresses off
//!   its subnet, a ULA and a `.local` (mDNS) name. They must reach only the proxy on every
//!   OS, except link-local IPv4 on macOS (the residual again).
//! - **off-machine**: a TEST-NET address of the side's own and an external canary name, and,
//!   when CI routes the probe's DNS zone to its listener ([`super::dns`]), a name in that zone
//!   to preconnect and one to `dns-prefetch`. They must reach only the proxy, and no resolver,
//!   on every OS. Main has its own TEST-NET address and zone names: they must never reach the
//!   proxy, since main isn't behind it, and main's names are the DNS route's positive
//!   control.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};

use serde_json::{Value, json};

use super::dns;

/// The sides that preconnect, as the probe names them.
pub const SIDES: [&str; 3] = ["widgets-host", "widget-iframe", "main"];

/// A destination class (see the module docs).
pub const ON_HOST: &str = "on-host";
pub const OFF_HOST: &str = "off-host";
pub const OFF_MACHINE: &str = "off-machine";

/// This host's address on the network it routes off-machine traffic through, if any. A UDP
/// `connect` only picks the route; it sends nothing.
pub fn lan_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(198, 51, 100, 1), 9)).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/// Another address on this host's /24, for a same-subnet target: .254, or .253 if this host
/// is .254. IPv4 only.
fn lan_peer(lan: IpAddr) -> Option<Ipv4Addr> {
    let IpAddr::V4(v4) = lan else { return None };
    let [a, b, c, d] = v4.octets();
    Some(Ipv4Addr::new(a, b, c, if d == 254 { 253 } else { 254 }))
}

/// A host for a URL authority: IPv6 in brackets.
fn url_host(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
    }
}

/// How a target is tried: a preconnect over http and https, or one `dns-prefetch`.
#[derive(Clone, Copy, PartialEq)]
enum Rel {
    Preconnect,
    DnsPrefetch,
}

type Target = (&'static str, &'static str, String, Rel);

/// The probe's DNS-zone targets of a side: a name to preconnect and one to `dns-prefetch`.
fn dns_targets(name: &str) -> [Target; 2] {
    [
        (
            "dns-name",
            OFF_MACHINE,
            format!("{name}.{}", dns::ZONE),
            Rel::Preconnect,
        ),
        (
            "dns-prefetch",
            OFF_MACHINE,
            format!("{name}-prefetch.{}", dns::ZONE),
            Rel::DnsPrefetch,
        ),
    ]
}

/// The targets of `side` (an index into [`SIDES`]): `(id, class, host, rel)`. `dns` adds the
/// probe's DNS-zone names (only when CI routes the zone to the probe's listener).
fn targets(side: usize, lan: Option<IpAddr>, dns: bool) -> Vec<Target> {
    let name = SIDES[side];
    let pre = |(id, class, host): (&'static str, &'static str, String)| {
        (id, class, host, Rel::Preconnect)
    };
    let mut list: Vec<Target> = Vec::new();
    if name == "main" {
        list.push(pre(("test-net", OFF_MACHINE, "198.51.100.9".to_owned())));
        if dns {
            list.extend(dns_targets(name));
        }
        return list;
    }
    let on_host = [
        ("loopback-v4", ON_HOST, "127.0.0.1".to_owned()),
        ("localhost", ON_HOST, "localhost".to_owned()),
        ("sub-localhost", ON_HOST, format!("rlx-{name}.localhost")),
        ("loopback-v6", ON_HOST, "[::1]".to_owned()),
    ];
    list.extend(on_host.into_iter().map(pre));
    if let Some(lan) = lan {
        list.push(pre(("own-lan-address", ON_HOST, url_host(lan))));
    }
    if let Some(peer) = lan.and_then(lan_peer) {
        list.push(pre(("lan-peer", OFF_HOST, peer.to_string())));
    }
    let off_host = [
        ("link-local-v4", "169.254.77.77"),
        ("link-local-v6", "[fe80::77]"),
        ("rfc1918-10", "10.255.255.1"),
        ("rfc1918-172", "172.31.255.254"),
        ("rfc1918-192", "192.168.255.254"),
        ("ula", "[fd00::77]"),
    ];
    for (id, host) in off_host {
        if lan.map(url_host).as_deref() != Some(host) {
            list.push(pre((id, OFF_HOST, host.to_owned())));
        }
    }
    list.push(pre(("mdns-name", OFF_HOST, format!("rlx-{name}.local"))));
    let test_net = if side == 0 {
        "198.51.100.7"
    } else {
        "198.51.100.8"
    };
    list.push(pre(("test-net", OFF_MACHINE, test_net.to_owned())));
    list.push(pre((
        "canary-name",
        OFF_MACHINE,
        format!("{name}.rlx-probe-canary.invalid"),
    )));
    if dns {
        list.extend(dns_targets(name));
    }
    list
}

/// The attempts of `side`, in order: `{ id, class, rel, scheme, host, port, authority, url }`.
/// On-host targets use the side's reach listener ports (`[http, https]`), so a direct
/// connection is seen; every other attempt has a port of its own. Either way each attempt's
/// CONNECT authority names it alone.
pub fn plan(side: usize, reach_ports: [u16; 2], lan: Option<IpAddr>, dns: bool) -> Vec<Value> {
    let base = 41_000 + 1_000 * side as u16;
    let mut attempts = Vec::new();
    for (index, (id, class, host, rel)) in targets(side, lan, dns).into_iter().enumerate() {
        let schemes: &[&str] = match rel {
            Rel::Preconnect => &["http", "https"],
            Rel::DnsPrefetch => &["http"],
        };
        for (offset, scheme) in schemes.iter().copied().enumerate() {
            let port = if class == ON_HOST {
                reach_ports[offset]
            } else {
                base + 2 * index as u16 + offset as u16
            };
            let authority = format!("{host}:{port}");
            attempts.push(json!({
                "id": id,
                "class": class,
                "rel": match rel {
                    Rel::Preconnect => "preconnect",
                    Rel::DnsPrefetch => "dns-prefetch",
                },
                "scheme": scheme,
                "host": host,
                "port": port,
                "authority": authority,
                "url": format!("{scheme}://{authority}/{}/{id}", SIDES[side]),
            }));
        }
    }
    attempts
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_side_has_its_own_off_machine_targets_and_unique_authorities() {
        let lan = Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)));
        let plans: Vec<Vec<Value>> = (0..3)
            .map(|side| plan(side, [5000 + side as u16, 6000 + side as u16], lan, false))
            .collect();
        let mut off = HashSet::new();
        for attempts in &plans {
            // Within a side every attempt, on-host ones too, has an authority of its own.
            let own: HashSet<&str> = attempts
                .iter()
                .filter(|a| a["rel"] == "preconnect")
                .map(|a| a["authority"].as_str().unwrap())
                .collect();
            assert_eq!(
                own.len(),
                attempts.iter().filter(|a| a["rel"] == "preconnect").count()
            );
            for attempt in attempts {
                if attempt["class"] != ON_HOST {
                    assert!(
                        off.insert(attempt["authority"].as_str().unwrap().to_owned()),
                        "{attempt}"
                    );
                }
            }
        }
        let test_net = |side: usize| {
            plans[side]
                .iter()
                .find(|a| a["id"] == "test-net")
                .map(|a| a["host"].as_str().unwrap().to_owned())
        };
        assert_eq!(test_net(0).as_deref(), Some("198.51.100.7"));
        assert_eq!(test_net(1).as_deref(), Some("198.51.100.8"));
        assert_eq!(test_net(2).as_deref(), Some("198.51.100.9"));
        // Main has only its TEST-NET target, over both schemes.
        assert_eq!(plans[2].len(), 2);
        // Both sides try every class over both schemes.
        for attempts in &plans[..2] {
            for class in [ON_HOST, OFF_HOST, OFF_MACHINE] {
                for scheme in ["http", "https"] {
                    assert!(
                        attempts
                            .iter()
                            .any(|a| a["class"] == class && a["scheme"] == scheme)
                    );
                }
            }
            assert!(
                attempts
                    .iter()
                    .any(|a| a["id"] == "own-lan-address" && a["host"] == "192.168.1.20")
            );
            assert!(
                attempts
                    .iter()
                    .any(|a| a["id"] == "lan-peer" && a["host"] == "192.168.1.254")
            );
            assert!(attempts.iter().all(|a| a["rel"] == "preconnect"));
            assert!(
                attempts
                    .iter()
                    .all(|a| !a["host"].as_str().unwrap().ends_with(dns::ZONE)),
                "no DNS-zone names unless CI routes the zone"
            );
        }
    }

    #[test]
    fn with_the_dns_route_every_side_has_its_own_zone_names() {
        for (side, name) in SIDES.into_iter().enumerate() {
            let attempts = plan(side, [5000, 6000], None, true);
            let preconnect: Vec<&Value> =
                attempts.iter().filter(|a| a["id"] == "dns-name").collect();
            assert_eq!(preconnect.len(), 2, "{name}: http and https");
            assert_eq!(preconnect[0]["host"], format!("{name}.{}", dns::ZONE));
            let prefetch: Vec<&Value> = attempts
                .iter()
                .filter(|a| a["id"] == "dns-prefetch")
                .collect();
            assert_eq!(prefetch.len(), 1, "{name}: one dns-prefetch");
            assert_eq!(prefetch[0]["rel"], "dns-prefetch");
            assert_eq!(
                prefetch[0]["host"],
                format!("{name}-prefetch.{}", dns::ZONE)
            );
        }
    }

    #[test]
    fn the_lan_address_is_never_also_an_off_host_target() {
        let peer = plan(
            0,
            [5000, 6000],
            Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 254))),
            false,
        );
        assert!(
            peer.iter()
                .any(|a| a["id"] == "lan-peer" && a["host"] == "192.168.1.253")
        );
        let lan = Some(IpAddr::V4(Ipv4Addr::new(10, 255, 255, 1)));
        let attempts = plan(0, [5000, 6000], lan, false);
        assert!(
            attempts
                .iter()
                .all(|a| !(a["class"] == OFF_HOST && a["host"] == "10.255.255.1"))
        );
        assert!(
            plan(0, [5000, 6000], None, false)
                .iter()
                .all(|a| a["id"] != "own-lan-address")
        );
    }
}
