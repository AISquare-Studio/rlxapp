//! What the widgets webview should show, kept by the core so nothing is lost to timing or to
//! a reload.
//!
//! The host page can't take a mount before host.js has run, and a widget frame can't take
//! data before its port exists. The webview can also be reloaded at any time (its context
//! menu, or F5 in WebView2), which empties the grid. So the core keeps the mounted set and
//! each widget's latest data, and on every page load of the widgets webview (`on_page_load`
//! Finished) it replays them: one `mount` with the host token, then one `data` per widget.
//! host.js keeps each widget's latest data until that widget's port exists.
//!
//! The host token goes to the host page once per page load, in that replay, and in no other
//! call.

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{Runtime, Webview};

use super::{HostFn, Registry, host_call, widget_url};

/// A widget to mount. The core builds its URL from the registry.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MountEntry {
    pub id: String,
    pub version: u32,
    pub title: String,
}

impl MountEntry {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "version": self.version, "url": widget_url(&self.id, self.version), "title": self.title })
    }
}

#[derive(Default)]
struct Inner {
    /// Whether the current page of the widgets webview has finished loading and been replayed.
    loaded: bool,
    /// How many page loads have finished (a reload adds one).
    loads: u64,
    mounted: Vec<MountEntry>,
    data: BTreeMap<String, Value>,
}

#[derive(Default)]
pub struct HostState {
    inner: Mutex<Inner>,
    changed: Condvar,
}

impl HostState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A navigation of the widgets webview started: its page is gone until it finishes.
    pub fn page_started(&self) {
        self.lock().loaded = false;
    }

    /// The widgets webview finished loading a page. Returns the script that restores it:
    /// mount everything (handing over the host token), then each widget's latest data.
    pub fn page_finished(&self, registry: &Registry) -> String {
        let mut inner = self.lock();
        let entries: Vec<Value> = inner.mounted.iter().map(MountEntry::to_json).collect();
        let mut script = vec![host_call(
            HostFn::Mount,
            &[
                Value::Array(entries),
                Value::String(registry.host_token().to_owned()),
            ],
        )];
        for (id, data) in &inner.data {
            script.push(host_call(
                HostFn::Data,
                &[Value::String(id.clone()), data.clone()],
            ));
        }
        inner.loaded = true;
        inner.loads += 1;
        self.changed.notify_all();
        script.join(";\n")
    }

    /// Adds registered entries to the mounted set (once per ID) and returns them.
    pub fn add_mounts(&self, registry: &Registry, entries: Vec<MountEntry>) -> Vec<MountEntry> {
        let mut inner = self.lock();
        let mut accepted = Vec::new();
        for entry in entries {
            if !registry.contains(&entry.id, entry.version) {
                continue;
            }
            if !inner.mounted.iter().any(|m| m.id == entry.id) {
                inner.mounted.push(entry.clone());
            }
            accepted.push(entry);
        }
        accepted
    }

    /// Stores a mounted widget's latest data. Returns whether the page is loaded, i.e.
    /// whether to send it now; it is replayed after every reload either way.
    pub fn set_data(&self, id: &str, data: Value) -> Result<bool, String> {
        let mut inner = self.lock();
        if !inner.mounted.iter().any(|m| m.id == id) {
            return Err(format!("widget {id:?} isn't mounted"));
        }
        inner.data.insert(id.to_owned(), data);
        Ok(inner.loaded)
    }

    /// Page loads finished so far.
    pub fn loads(&self) -> u64 {
        self.lock().loads
    }

    /// Waits until the current page has loaded; returns the load count, or None on timeout.
    pub fn wait_loaded(&self, timeout: Duration) -> Option<u64> {
        let deadline = Instant::now() + timeout;
        let mut inner = self.lock();
        while !inner.loaded {
            let left = deadline.checked_duration_since(Instant::now())?;
            inner = self
                .changed
                .wait_timeout(inner, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        Some(inner.loads)
    }
}

/// Mounts `entries` and returns the IDs the host page reports it has mounted. Blocks until
/// the page has loaded and has answered, so success means the frames exist. Run it off the
/// main thread.
pub fn mount_now<R: Runtime>(
    widgets: &Webview<R>,
    state: &HostState,
    registry: &Registry,
    entries: Vec<MountEntry>,
    timeout: Duration,
) -> Result<Vec<String>, String> {
    let accepted = state.add_mounts(registry, entries);
    if state.wait_loaded(timeout).is_none() {
        return Err("the widgets webview hasn't finished loading".into());
    }
    let list = Value::Array(accepted.iter().map(MountEntry::to_json).collect());
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    widgets
        .eval_with_callback(host_call(HostFn::Mount, &[list]), move |result| {
            if let Ok(tx) = tx.lock() {
                let _ = tx.send(result);
            }
        })
        .map_err(|e| e.to_string())?;
    let raw = rx
        .recv_timeout(timeout)
        .map_err(|_| "the host page didn't answer the mount".to_owned())?;
    serde_json::from_str::<Vec<String>>(&raw)
        .map_err(|_| format!("the host page answered the mount with {raw}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::widget_host::{Placement, Policy, Source, Switch};
    use std::sync::Arc;

    fn registry() -> Registry {
        let registry = Registry::new(Policy {
            widget_webview: true,
            builtins: Placement::Widgets,
            agent_widgets: Switch::Off("test"),
        });
        for id in ["clock", "timer"] {
            registry
                .register(Source::Builtin, id, 1, "<p>w</p>")
                .unwrap();
        }
        registry
    }

    fn entry(id: &str) -> MountEntry {
        MountEntry {
            id: id.into(),
            version: 1,
            title: id.into(),
        }
    }

    #[test]
    fn mounts_only_registered_widgets_once_each() {
        let (registry, state) = (registry(), HostState::default());
        let accepted = state.add_mounts(
            &registry,
            vec![entry("clock"), entry("nope"), entry("clock")],
        );
        assert_eq!(accepted, vec![entry("clock"), entry("clock")]);
        assert_eq!(state.lock().mounted, vec![entry("clock")]);
    }

    #[test]
    fn every_page_load_replays_the_grid_and_the_latest_data_with_the_token() {
        let (registry, state) = (registry(), HostState::default());
        state.add_mounts(&registry, vec![entry("clock"), entry("timer")]);
        assert_eq!(
            state.set_data("clock", json!({ "t": 1 })),
            Ok(false),
            "not loaded yet"
        );
        state.set_data("clock", json!({ "t": 2 })).unwrap();
        assert!(state.set_data("nope", json!(1)).is_err());

        let first = state.page_finished(&registry);
        let token = registry.host_token();
        let lines: Vec<&str> = first.split(";\n").collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("window.__rlxHost.mount([{"));
        assert!(lines[0].ends_with(&format!(",\"{token}\")")));
        assert!(lines[0].contains("\"id\":\"clock\"") && lines[0].contains("\"id\":\"timer\""));
        assert_eq!(lines[1], "window.__rlxHost.data(\"clock\",{\"t\":2})");
        assert_eq!(state.loads(), 1);
        assert_eq!(
            state.set_data("timer", json!(3)),
            Ok(true),
            "loaded: send now"
        );

        // A reload: the page is gone until it finishes, then everything comes back.
        state.page_started();
        assert!(state.wait_loaded(Duration::from_millis(10)).is_none());
        let second = state.page_finished(&registry);
        assert_eq!(second.split(";\n").count(), 3);
        assert_eq!(state.loads(), 2);
    }

    #[test]
    fn the_token_travels_only_in_the_replay() {
        let (registry, state) = (registry(), HostState::default());
        state.add_mounts(&registry, vec![entry("clock")]);
        state.set_data("clock", json!("x")).unwrap();
        let token = registry.host_token().to_owned();
        let replay = state.page_finished(&registry);
        assert_eq!(replay.matches(&token).count(), 1);
        let later = host_call(
            HostFn::Mount,
            &[Value::Array(vec![entry("clock").to_json()])],
        );
        assert!(!later.contains(&token));
    }

    #[test]
    fn waiting_for_the_page_wakes_on_load() {
        let registry = Arc::new(registry());
        let state = Arc::new(HostState::default());
        let (s, r) = (Arc::clone(&state), Arc::clone(&registry));
        let loader = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            s.page_finished(&r);
        });
        assert_eq!(state.wait_loaded(Duration::from_secs(5)), Some(1));
        loader.join().unwrap();
    }
}
