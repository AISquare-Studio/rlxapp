//! rlxapp core: the Tauri process that hosts the web UI.

mod probe;

use probe::Probe;
use serde::Serialize;

/// Static facts about the running build, shown on the placeholder screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
}

impl AppInfo {
    pub fn current() -> Self {
        Self {
            name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo::current()
}

#[tauri::command]
fn report_first_paint(
    probe: tauri::State<'_, Probe>,
    epoch_ms: f64,
    source: String,
) -> Result<(), String> {
    probe
        .record_first_paint(epoch_ms, &source)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Probe::from_env())
        .invoke_handler(tauri::generate_handler![app_info, report_first_paint])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_matches_the_crate_and_host() {
        let info = AppInfo::current();
        assert_eq!(info.name, "rlxapp");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.os, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
    }

    #[test]
    fn app_info_serializes_to_the_shape_the_ui_expects() {
        let json = serde_json::to_value(AppInfo::current()).unwrap();
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["arch", "name", "os", "version"]);
    }
}
