//! Startup probe used by `scripts/measure-budgets.sh` and `scripts/smoke-test.mjs`.
//!
//! When the app is launched with `RLXAPP_STARTUP_PROBE=<file>`, the web UI
//! reports its first contentful paint and the core appends one line to that
//! file. Without the variable this is a no-op, so normal launches never touch
//! the filesystem.

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::PathBuf;

/// Environment variable naming the file the probe appends to.
pub const ENV_VAR: &str = "RLXAPP_STARTUP_PROBE";

/// Where first-paint events go, if anywhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    path: Option<PathBuf>,
}

impl Probe {
    /// Reads the target file from [`ENV_VAR`]; empty or unset disables the probe.
    pub fn from_env() -> Self {
        Self::new(std::env::var_os(ENV_VAR).map(PathBuf::from))
    }

    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path: path.filter(|p| !p.as_os_str().is_empty()),
        }
    }

    /// Appends a first-paint line. Returns `Ok(false)` when the probe is disabled.
    pub fn record_first_paint(&self, epoch_ms: f64, source: &str) -> io::Result<bool> {
        let Some(path) = &self.path else {
            return Ok(false);
        };
        let line = format_first_paint(epoch_ms, source)?;
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        file.write_all(line.as_bytes())?;
        Ok(true)
    }
}

/// Formats one probe line: `first_paint epoch_ms=<ms with 3 decimals> source=<fcp|raf>`.
pub fn format_first_paint(epoch_ms: f64, source: &str) -> io::Result<String> {
    if !epoch_ms.is_finite() || epoch_ms <= 0.0 {
        return Err(invalid(format!(
            "epoch_ms must be a positive number, got {epoch_ms}"
        )));
    }
    if !matches!(source, "fcp" | "raf") {
        return Err(invalid(format!("unknown paint source {source:?}")));
    }
    Ok(format!(
        "first_paint epoch_ms={epoch_ms:.3} source={source}\n"
    ))
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_file(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "rlxapp-probe-{name}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn formats_a_parseable_line() {
        let line = format_first_paint(1_700_000_000_123.456_7, "fcp").unwrap();
        assert_eq!(line, "first_paint epoch_ms=1700000000123.457 source=fcp\n");
    }

    #[test]
    fn rejects_nonsense_input() {
        assert!(format_first_paint(f64::NAN, "fcp").is_err());
        assert!(format_first_paint(-1.0, "fcp").is_err());
        assert!(format_first_paint(1.0, "paint; rm -rf").is_err());
    }

    #[test]
    fn disabled_probe_writes_nothing() {
        assert!(!Probe::new(None).record_first_paint(1.0, "fcp").unwrap());
        assert_eq!(Probe::new(Some(PathBuf::new())).path, None);
    }

    #[test]
    fn enabled_probe_appends_lines() {
        let path = temp_file("append");
        let probe = Probe::new(Some(path.clone()));

        assert!(probe.record_first_paint(10.0, "fcp").unwrap());
        assert!(probe.record_first_paint(20.5, "raf").unwrap());

        let contents = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            contents,
            "first_paint epoch_ms=10.000 source=fcp\nfirst_paint epoch_ms=20.500 source=raf\n"
        );
    }
}
