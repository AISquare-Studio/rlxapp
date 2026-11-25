//! The widget host's commands for the UI (see the module doc in mod.rs for the API).
//!
//! Each is granted to the `main` webview only (capabilities/default.json). The ACL refuses
//! them from `widgets`, and each also checks the calling webview itself.

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{Manager, Runtime, Webview};

use super::{
    Bounds, HostFn, LABEL, PolicyInfo, Registry, Source, attach, host_call, mount_call, widget_url,
};

/// A widget to mount: the core builds its URL from the registry.
#[derive(Debug, Clone, Deserialize)]
pub struct MountEntry {
    pub id: String,
    pub version: u32,
    pub title: String,
}

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

#[tauri::command]
pub fn widgets_policy(registry: tauri::State<'_, Registry>) -> PolicyInfo {
    registry.policy().into()
}

#[tauri::command]
pub fn widgets_show<R: Runtime>(
    webview: Webview<R>,
    registry: tauri::State<'_, Registry>,
    bounds: Bounds,
) -> Result<(), String> {
    from_main(&webview)?;
    let rect = tauri::Rect {
        position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
        size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
    };
    match widgets_webview(&webview) {
        Some(widgets) => {
            widgets.set_bounds(rect).map_err(|e| e.to_string())?;
            widgets.show().map_err(|e| e.to_string())
        }
        None => attach(&webview.window(), registry.policy(), bounds)
            .map(|_| ())
            .map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub fn widgets_hide<R: Runtime>(webview: Webview<R>) -> Result<(), String> {
    from_main(&webview)?;
    match widgets_webview(&webview) {
        Some(widgets) => widgets.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn widgets_mount<R: Runtime>(
    webview: Webview<R>,
    registry: tauri::State<'_, Registry>,
    widgets: Vec<MountEntry>,
) -> Result<Vec<String>, String> {
    from_main(&webview)?;
    let host = widgets_webview(&webview).ok_or("the widgets webview isn't shown yet")?;
    let entries: Vec<Value> = widgets
        .iter()
        .filter(|w| registry.contains(&w.id, w.version))
        .map(|w| {
            json!({ "id": w.id, "version": w.version, "url": widget_url(&w.id, w.version), "title": w.title })
        })
        .collect();
    let mounted = entries
        .iter()
        .filter_map(|e| e["id"].as_str().map(str::to_owned))
        .collect();
    host.eval(mount_call(&registry, Value::Array(entries)))
        .map_err(|e| e.to_string())?;
    Ok(mounted)
}

#[tauri::command]
pub fn widgets_push<R: Runtime>(
    webview: Webview<R>,
    id: String,
    data: Value,
) -> Result<(), String> {
    from_main(&webview)?;
    let host = widgets_webview(&webview).ok_or("the widgets webview isn't shown yet")?;
    host.eval(host_call(HostFn::Data, &[Value::String(id), data]))
        .map_err(|e| e.to_string())
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
