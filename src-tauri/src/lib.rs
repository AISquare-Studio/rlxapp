//! rlxapp core: the Tauri process that hosts the web UI.

#[cfg(feature = "e2e")]
mod e2e;

// The e2e feature carries the canary command and a registry bypass for the probe's fixtures.
// Test builds are debug builds (`npm run e2e:build`); a release never carries it.
#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!("the e2e feature is for debug test builds only (npm run e2e:build)");
pub mod engine_home;
mod probe;
pub mod widget_host;

use probe::Probe;
use serde::Serialize;
use tauri::http::{Request, Response};
use tauri::{AppHandle, Emitter, Manager, Runtime, UriSchemeContext, WindowEvent};

/// The user-facing app name. Must equal `productName` in tauri.conf.json (checked by a test);
/// the crate and repository keep the name `rlxapp`.
pub const PRODUCT_NAME: &str = "rlx";

/// The bundle identifier. Fixed before the first release: it keys app data and Keychain items.
pub const BUNDLE_ID: &str = "studio.aisquare.rlx";

/// Static facts about the running build, shown in the About box.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    /// Launched under the startup probe (scripts/measure-budgets.sh): the UI then opens on Home
    /// without saving settings, so the budgets are measured on Home, not onboarding.
    pub measuring: bool,
}

impl AppInfo {
    pub fn current() -> Self {
        Self {
            name: PRODUCT_NAME,
            version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            measuring: std::env::var_os(probe::ENV_VAR).is_some(),
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

/// Serves the widget scheme (src/widget_host/). Test builds add the isolation probe's routes.
fn widget_scheme<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let app = ctx.app_handle();
    let registry = app.state::<widget_host::Registry>();
    #[cfg(feature = "e2e")]
    let probe = app.try_state::<e2e::Probe>();
    #[cfg(feature = "e2e")]
    let extras = probe
        .as_ref()
        .map(|probe| probe.inner() as &dyn widget_host::HostExtras);
    #[cfg(not(feature = "e2e"))]
    let extras = None;
    let (response, action) = widget_host::respond(&registry, extras, ctx.webview_label(), &request);
    if let Some(action) = action {
        #[cfg(feature = "e2e")]
        if let Some(probe) = &probe {
            probe.record_action(&action);
        }
        let main = tauri::EventTarget::webview("main");
        if let Err(error) = app.emit_to(main, widget_host::ACTION_EVENT, &action) {
            eprintln!("widget action not delivered: {error}");
        }
    }
    response
}

/// Brings the main window back: from a second launch (single instance), the Dock, or the rlx
/// service tray's "Open rlx app" (which launches the app, so it arrives as a second launch).
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(true);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Closing the window hides it and keeps the process alive, so the app's gate stays connected
/// for scheduled jobs. The app draws no tray: the one tray icon belongs to the rlx service
/// (rlxd). On macOS the Dock icon goes too, until the window comes back.
fn hide_main<R: Runtime>(window: &tauri::Window<R>) {
    let _ = window.hide();
    #[cfg(target_os = "macos")]
    let _ = window.app_handle().set_dock_visibility(false);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // First, so a second launch exits early and focuses this one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .manage(Probe::from_env())
        .manage(widget_host::Registry::default())
        .manage(widget_host::state::HostState::default())
        .register_uri_scheme_protocol(widget_host::SCHEME, widget_scheme)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                api.prevent_close();
                hide_main(window);
            }
        });

    #[cfg(not(feature = "e2e"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app_info,
        report_first_paint,
        widget_host::commands::widgets_policy,
        widget_host::commands::widgets_show,
        widget_host::commands::widgets_hide,
        widget_host::commands::widgets_mount,
        widget_host::commands::widgets_push,
        widget_host::commands::widgets_register
    ]);

    // Test builds: the isolation probe's state, canary command and hooks (src/e2e/).
    #[cfg(feature = "e2e")]
    let builder = builder
        .manage(e2e::Probe::from_env())
        .invoke_handler(tauri::generate_handler![
            app_info,
            report_first_paint,
            widget_host::commands::widgets_policy,
            widget_host::commands::widgets_show,
            widget_host::commands::widgets_hide,
            widget_host::commands::widgets_mount,
            widget_host::commands::widgets_push,
            widget_host::commands::widgets_register,
            e2e::e2e_canary
        ])
        .on_page_load(e2e::page_loaded)
        .setup(|app| {
            e2e::setup(app)?;
            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        // Opening the app again (Finder, Spotlight, the Dock) while it runs hidden brings the
        // window back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            show_main(_app);
        }
    });
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
        assert_eq!(keys, ["arch", "measuring", "name", "os", "version"]);
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
            serde_json::json!([
                "core:default",
                "allow-app-info",
                "allow-report-first-paint",
                "allow-widgets-policy",
                "allow-widgets-show",
                "allow-widgets-hide",
                "allow-widgets-mount",
                "allow-widgets-push",
                "allow-widgets-register"
            ])
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
    fn the_e2e_config_overlay_only_adds_a_webview2_debugging_port() {
        // `npm run e2e:build` merges tauri.e2e.conf.json over tauri.conf.json, so msedgedriver
        // can attach on Windows. The overlay's window must otherwise equal the product's.
        let mut overlay = json(include_str!("../tauri.e2e.conf.json"))["app"]["windows"][0].clone();
        let args = overlay
            .as_object_mut()
            .unwrap()
            .remove("additionalBrowserArgs")
            .expect("the overlay sets additionalBrowserArgs");
        assert_eq!(
            args,
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9222"
        );
        let config = json(include_str!("../tauri.conf.json"));
        assert_eq!(overlay, config["app"]["windows"][0]);
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

    /// Every Rust source of the product build (src/, minus the test-only e2e module).
    fn product_sources() -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut dirs = vec![std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src"
        ))];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).expect("src dir").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if path.file_name().is_some_and(|n| n != "e2e") {
                        dirs.push(path);
                    }
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).expect("readable");
                    out.push((path.display().to_string(), text));
                }
            }
        }
        out
    }

    #[test]
    fn the_app_draws_no_tray_icon() {
        // The one tray icon belongs to the rlx service (rlxd); the app creates none.
        let builder = concat!("Tray", "IconBuilder");
        let api = concat!("tauri::", "tray");
        for (path, text) in product_sources() {
            assert!(!text.contains(builder), "{path} builds a tray icon");
            assert!(!text.contains(api), "{path} uses the tray API");
        }
        let manifest = include_str!("../Cargo.toml");
        assert!(
            !manifest.contains(concat!("tray", "-icon")),
            "Cargo.toml enables the tray-icon feature"
        );
    }

    #[test]
    fn the_app_registers_no_login_item() {
        // "Start rlx at login" is the rlx service's registration, set through the Engine.
        let forbidden = [
            concat!("Launch", "Agents"),
            concat!("SMApp", "Service"),
            concat!("auto", "start"),
            concat!("auto", "_launch"),
            concat!("Login", "Items"),
        ];
        for (path, text) in product_sources() {
            for word in forbidden {
                assert!(!text.contains(word), "{path} mentions {word}");
            }
        }
        let manifest = include_str!("../Cargo.toml");
        for plugin in [
            concat!("tauri-plugin-auto", "start"),
            concat!("auto-", "launch"),
        ] {
            assert!(!manifest.contains(plugin), "Cargo.toml depends on {plugin}");
        }
    }
}
