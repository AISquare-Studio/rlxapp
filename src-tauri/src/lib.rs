//! rlxapp core: the Tauri process that hosts the web UI.

mod probe;

use probe::Probe;
use serde::Serialize;

/// The user-facing app name. Must equal `productName` in tauri.conf.json (checked by a test);
/// the crate and repository keep the name `rlxapp`.
pub const PRODUCT_NAME: &str = "rlx";

/// The bundle identifier. Fixed before the first release: it keys app data and Keychain items.
pub const BUNDLE_ID: &str = "studio.aisquare.rlx";

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
            name: PRODUCT_NAME,
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

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).expect("valid JSON")
    }

    #[test]
    fn app_info_matches_the_crate_and_host() {
        let info = AppInfo::current();
        assert_eq!(info.name, "rlx");
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

    #[test]
    fn tauri_config_uses_the_product_name_and_bundle_id() {
        let config = json(include_str!("../tauri.conf.json"));
        assert_eq!(config["productName"], PRODUCT_NAME);
        assert_eq!(config["identifier"], BUNDLE_ID);
        assert_eq!(config["app"]["windows"][0]["title"], PRODUCT_NAME);
    }

    #[test]
    fn crate_version_matches_package_json() {
        // tauri.conf.json takes its version from package.json; keep Cargo.toml in step.
        let package = json(include_str!("../../package.json"));
        assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn capability_grants_the_main_webview_only_core_and_the_app_commands() {
        let capability = json(include_str!("../capabilities/default.json"));
        // A webview, never a window: a window grant would leak to child webviews (widgets).
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert!(
            capability.get("windows").is_none(),
            "grant webviews, not windows"
        );
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["core:default", "allow-app-info", "allow-report-first-paint"])
        );
    }

    #[test]
    fn main_csp_allows_no_frames_objects_base_or_forms() {
        let config = json(include_str!("../tauri.conf.json"));
        let csp = config["app"]["security"]["csp"]
            .as_object()
            .expect("CSP is set as an object");
        for directive in ["frame-src", "object-src", "base-uri", "form-action"] {
            assert_eq!(csp[directive], "'none'", "{directive}");
        }
        assert_eq!(csp["default-src"], "'self'");
        assert_eq!(csp["style-src"], "'self'");
        for (directive, sources) in csp {
            let sources = sources.as_str().unwrap_or_default();
            assert!(!sources.contains("'unsafe-"), "{directive}: {sources}");
            assert!(!sources.contains('*'), "{directive}: {sources}");
        }
    }

    #[test]
    fn linux_packages_are_named_rlxapp_but_the_desktop_entry_says_rlx() {
        // The deb/rpm package name follows productName; keep it off the rlx CLI's name.
        let linux = json(include_str!("../tauri.linux.conf.json"));
        assert_eq!(linux["productName"], "rlxapp");
        let template = "linux/rlx.desktop";
        assert_eq!(linux["bundle"]["linux"]["deb"]["desktopTemplate"], template);
        assert_eq!(linux["bundle"]["linux"]["rpm"]["desktopTemplate"], template);
        let desktop = include_str!("../linux/rlx.desktop");
        assert!(
            desktop
                .lines()
                .any(|line| line == format!("Name={PRODUCT_NAME}"))
        );
    }
}
