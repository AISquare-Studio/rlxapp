//! The widget host's commands for the UI (see the module doc in mod.rs for the API).
//!
//! Each is granted to the `main` webview only (capabilities/default.json). The ACL refuses
//! them from `widgets`, and each also checks the calling webview itself.

use std::time::Duration;

use serde_json::Value;
use tauri::{Manager, Runtime, Webview};

use super::state::{HostState, MountEntry, mount_now};
use super::{Bounds, HostFn, LABEL, PolicyInfo, Registry, Source, attach, host_call};

/// How long a mount waits for the host page to load and answer.
const MOUNT_TIMEOUT: Duration = Duration::from_secs(15);

fn from_main<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("widget host commands are for the main webview".into())
    }
}

fn widgets_webview<R: Runtime>(webview: &Webview<R>) -> Option<Webview<R>> {
    webview.app_handle().get_webview(LABEL)
}

fn valid_bounds(bounds: &Bounds) -> Result<(), String> {
    let finite = [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.0);
    if finite {
        Ok(())
    } else {
        Err("bounds must be finite and ≥ 0".into())
    }
}

#[tauri::command]
pub fn widgets_policy<R: Runtime>(
    webview: Webview<R>,
    registry: tauri::State<'_, Registry>,
) -> Result<PolicyInfo, String> {
    from_main(&webview)?;
    Ok(registry.policy().into())
}

/// Async, and off the async runtime's threads: `add_child` waits on the main thread, which
/// deadlocks a synchronous command on Windows.
#[tauri::command]
pub async fn widgets_show<R: Runtime>(webview: Webview<R>, bounds: Bounds) -> Result<(), String> {
    from_main(&webview)?;
    valid_bounds(&bounds)?;
    tauri::async_runtime::spawn_blocking(move || {
        let rect = tauri::Rect {
            position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
            size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
        };
        match widgets_webview(&webview) {
            Some(widgets) => {
                widgets.set_bounds(rect).map_err(|e| e.to_string())?;
                widgets.show().map_err(|e| e.to_string())
            }
            None => {
                let policy = webview.state::<Registry>().policy();
                attach(&webview.window(), policy, bounds)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn widgets_hide<R: Runtime>(webview: Webview<R>) -> Result<(), String> {
    from_main(&webview)?;
    match widgets_webview(&webview) {
        Some(widgets) => widgets.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Resolves only once the host page has mounted the widgets, with the IDs it reports.
#[tauri::command]
pub async fn widgets_mount<R: Runtime>(
    webview: Webview<R>,
    widgets: Vec<MountEntry>,
) -> Result<Vec<String>, String> {
    from_main(&webview)?;
    let host = widgets_webview(&webview).ok_or("the widgets webview isn't shown yet")?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = host.state::<HostState>();
        let registry = host.state::<Registry>();
        mount_now(&host, &state, &registry, widgets, MOUNT_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Keeps the widget's latest data and sends it now if the host page is loaded. It is sent
/// again after every reload of the widgets webview.
#[tauri::command]
pub fn widgets_push<R: Runtime>(
    webview: Webview<R>,
    state: tauri::State<'_, HostState>,
    id: String,
    data: Value,
) -> Result<(), String> {
    from_main(&webview)?;
    let loaded = state.set_data(&id, data.clone())?;
    if loaded && let Some(host) = widgets_webview(&webview) {
        host.eval(host_call(HostFn::Data, &[Value::String(id), data]))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// HTML from the UI is always agent-made: refused while the switch is off.
#[tauri::command]
pub fn widgets_register<R: Runtime>(
    webview: Webview<R>,
    registry: tauri::State<'_, Registry>,
    id: String,
    version: u32,
    html: String,
) -> Result<String, String> {
    from_main(&webview)?;
    registry
        .register(Source::Agent, &id, version, &html)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_must_be_finite_and_not_negative() {
        let ok = Bounds {
            x: 0.0,
            y: 10.0,
            width: 300.0,
            height: 200.0,
        };
        assert!(valid_bounds(&ok).is_ok());
        for bad in [f64::NAN, f64::INFINITY, -1.0] {
            let bounds = Bounds { width: bad, ..ok };
            assert!(valid_bounds(&bounds).is_err(), "{bad}");
        }
    }
}
