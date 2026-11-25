//! The action route: `POST <origin>/host/action` (docs/architecture.md §5.2, §5.3).
//!
//! The host page forwards each message a widget sends on its port as
//! `{ "widgetId": "...", "message": FromWidget }`. The core accepts it only:
//! - from the `widgets` webview (the scheme handler's label, which a page can't forge);
//! - from the host page's top frame, proven by the per-launch host token. The core hands
//!   the token to the host page by `Webview::eval`, which reaches only the top frame, with
//!   its first mount. The token never appears in a served resource, so a widget frame, or a
//!   copy of the host page loaded inside one, can't present it. WebKit sends no `Origin` on
//!   a same-origin POST to a custom scheme, so the token is what proves the host origin;
//! - with no `Origin`, or with `Origin` equal to the host origin. A sandboxed frame's
//!   `null`, or any other page's origin, is refused;
//! - when it parses as one of the `FromWidget` shapes, within the size limits.
//!
//! What an accepted action then does (open a URL, notify, draft a send, refresh) is the
//! core's and the UI's job, through the `widget-action` event to main. The core re-validates
//! there too (e.g. `openUrl` must be https and in the widget's current data).

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::http::StatusCode;

use super::{LABEL, origin, valid_id};

/// The header that carries the host token.
pub const TOKEN_HEADER: &str = "x-rlx-host-token";

/// Largest action body the route reads.
pub const MAX_BODY_BYTES: usize = 96 * 1024;
/// Largest `setState` state, serialized (§5.2).
pub const MAX_STATE_BYTES: usize = 64 * 1024;

/// One widget → core message (`FromWidget`, §5.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum FromWidget {
    Ready {
        v: u8,
    },
    Refresh {
        v: u8,
    },
    SetState {
        v: u8,
        state: serde_json::Map<String, Value>,
    },
    OpenUrl {
        v: u8,
        url: String,
    },
    Notify {
        v: u8,
        title: String,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
    },
    DraftSend {
        v: u8,
        connector: String,
        destination: String,
        body: String,
    },
    Resize {
        v: u8,
        h: f64,
    },
}

impl FromWidget {
    fn version(&self) -> u8 {
        match self {
            Self::Ready { v }
            | Self::Refresh { v }
            | Self::SetState { v, .. }
            | Self::OpenUrl { v, .. }
            | Self::Notify { v, .. }
            | Self::DraftSend { v, .. }
            | Self::Resize { v, .. } => *v,
        }
    }
}

/// An accepted action, as the `widget-action` event carries it to main.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetAction {
    pub widget_id: String,
    pub message: FromWidget,
}

/// What the route needs from one request.
#[derive(Debug, Clone, Copy)]
pub struct RouteRequest<'a> {
    pub webview_label: &'a str,
    pub origin: Option<&'a str>,
    pub token: Option<&'a str>,
    pub is_post: bool,
    pub body: &'a [u8],
}

#[derive(Debug, PartialEq, Eq)]
pub enum ActionError {
    WrongWebview,
    /// The host token is missing or wrong: not the host page's top frame.
    NotTheHost,
    /// With the `Origin` the request carried, if any.
    WrongOrigin(Option<String>),
    NotPost,
    TooLarge,
    Invalid(String),
}

impl ActionError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::WrongWebview | Self::NotTheHost | Self::WrongOrigin(_) => StatusCode::FORBIDDEN,
            Self::NotPost => StatusCode::METHOD_NOT_ALLOWED,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Invalid(_) => StatusCode::BAD_REQUEST,
        }
    }
}

impl fmt::Display for ActionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongWebview => write!(f, "actions are accepted only from the widgets webview"),
            Self::NotTheHost => write!(f, "actions are accepted only from the host page"),
            Self::WrongOrigin(got) => write!(
                f,
                "actions are accepted only from the host origin (got {})",
                got.as_deref().unwrap_or("no Origin")
            ),
            Self::NotPost => write!(f, "POST only"),
            Self::TooLarge => write!(f, "action body over {MAX_BODY_BYTES} bytes"),
            Self::Invalid(why) => write!(f, "invalid action: {why}"),
        }
    }
}

/// Checks one action request against the launch's host token.
pub fn accept(request: &RouteRequest<'_>, host_token: &str) -> Result<WidgetAction, ActionError> {
    if request.webview_label != LABEL {
        return Err(ActionError::WrongWebview);
    }
    if host_token.is_empty() || request.token != Some(host_token) {
        return Err(ActionError::NotTheHost);
    }
    if let Some(got) = request.origin
        && got != origin()
    {
        return Err(ActionError::WrongOrigin(Some(got.to_owned())));
    }
    let (is_post, body) = (request.is_post, request.body);
    if !is_post {
        return Err(ActionError::NotPost);
    }
    if body.len() > MAX_BODY_BYTES {
        return Err(ActionError::TooLarge);
    }
    let action: WidgetAction =
        serde_json::from_slice(body).map_err(|error| ActionError::Invalid(error.to_string()))?;
    let invalid = |why: &str| Err(ActionError::Invalid(why.to_owned()));
    if !valid_id(&action.widget_id) {
        return invalid("bad widget id");
    }
    if action.message.version() != 1 {
        return invalid("unknown message version");
    }
    match &action.message {
        FromWidget::SetState { state, .. } => {
            let size = serde_json::to_vec(state)
                .map(|b| b.len())
                .unwrap_or(usize::MAX);
            if size > MAX_STATE_BYTES {
                return invalid("state over 64 KB");
            }
        }
        FromWidget::OpenUrl { url, .. } => {
            let is_https = tauri::Url::parse(url).is_ok_and(|u| u.scheme() == "https");
            if !is_https || url.len() > 2048 {
                return invalid("openUrl needs an https URL");
            }
        }
        FromWidget::Notify { title, body, .. } => {
            if title.chars().count() > 200 || body.chars().count() > 2000 {
                return invalid("notification too long");
            }
        }
        FromWidget::DraftSend {
            connector,
            destination,
            body,
            ..
        } => {
            if connector.is_empty() || destination.is_empty() || body.len() > 32 * 1024 {
                return invalid("draftSend needs a connector, a destination and a body ≤ 32 KB");
            }
        }
        FromWidget::Resize { h, .. } => {
            if !h.is_finite() || !(16.0..=4000.0).contains(h) {
                return invalid("resize height out of range");
            }
        }
        FromWidget::Ready { .. } | FromWidget::Refresh { .. } => {}
    }
    Ok(action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOKEN: &str = "launch-token";

    fn body(value: Value) -> Vec<u8> {
        serde_json::to_vec(&value).unwrap()
    }

    fn request<'a>(body: &'a [u8]) -> RouteRequest<'a> {
        RouteRequest {
            webview_label: LABEL,
            origin: None,
            token: Some(TOKEN),
            is_post: true,
            body,
        }
    }

    fn post(value: Value) -> Result<WidgetAction, ActionError> {
        accept(&request(&body(value)), TOKEN)
    }

    fn refresh() -> Vec<u8> {
        body(json!({ "widgetId": "clock", "message": { "type": "refresh", "v": 1 } }))
    }

    #[test]
    fn accepts_a_valid_action_from_the_host_page() {
        let action = post(json!({ "widgetId": "clock", "message": { "type": "refresh", "v": 1 } }));
        assert_eq!(
            action,
            Ok(WidgetAction {
                widget_id: "clock".into(),
                message: FromWidget::Refresh { v: 1 },
            })
        );
        let open = json!({ "widgetId": "prs", "message": { "type": "openUrl", "v": 1, "url": "https://github.com/x" } });
        assert!(post(open).is_ok());
        // With the host origin present (WebView2 sends it) it passes too.
        let body = refresh();
        let with_origin = RouteRequest {
            origin: Some(origin()),
            ..request(&body)
        };
        assert!(accept(&with_origin, TOKEN).is_ok());
    }

    #[test]
    fn rejects_any_other_label() {
        let body = refresh();
        for label in ["main", "widgets2", "", "Widgets"] {
            let other = RouteRequest {
                webview_label: label,
                ..request(&body)
            };
            assert_eq!(
                accept(&other, TOKEN),
                Err(ActionError::WrongWebview),
                "{label}"
            );
        }
    }

    #[test]
    fn rejects_anything_but_the_host_page_top_frame() {
        let body = refresh();
        for token in [None, Some(""), Some("guess"), Some("launch-token ")] {
            let framed = RouteRequest {
                token,
                ..request(&body)
            };
            assert_eq!(
                accept(&framed, TOKEN),
                Err(ActionError::NotTheHost),
                "{token:?}"
            );
        }
        // No token was ever issued: nothing passes, not even an empty header.
        let empty = RouteRequest {
            token: Some(""),
            ..request(&body)
        };
        assert_eq!(accept(&empty, ""), Err(ActionError::NotTheHost));
    }

    #[test]
    fn rejects_any_other_origin() {
        let body = refresh();
        let other_form = if cfg!(windows) {
            "rlxwidget://localhost"
        } else {
            "http://rlxwidget.localhost"
        };
        for bad in [
            "null",
            "",
            "tauri://localhost",
            "http://tauri.localhost",
            "rlxwidget://evil",
            "http://rlxwidget.evil",
            "http://127.0.0.1:1420",
            other_form,
        ] {
            let request = RouteRequest {
                origin: Some(bad),
                ..request(&body)
            };
            assert_eq!(
                accept(&request, TOKEN),
                Err(ActionError::WrongOrigin(Some(bad.to_owned()))),
                "{bad}"
            );
        }
        let get = RouteRequest {
            is_post: false,
            ..request(&body)
        };
        assert_eq!(accept(&get, TOKEN), Err(ActionError::NotPost));
    }

    #[test]
    fn rejects_malformed_and_out_of_contract_messages() {
        let cases = [
            json!({ "widgetId": "clock" }),
            json!({ "widgetId": "clock", "message": { "type": "refresh" } }),
            json!({ "widgetId": "clock", "message": { "type": "refresh", "v": 2 } }),
            json!({ "widgetId": "clock", "message": { "type": "invoke", "v": 1, "cmd": "app_info" } }),
            json!({ "widgetId": "clock", "message": { "type": "refresh", "v": 1, "extra": true } }),
            json!({ "widgetId": "../x", "message": { "type": "refresh", "v": 1 } }),
            json!({ "widgetId": "x", "message": { "type": "openUrl", "v": 1, "url": "http://example.com" } }),
            json!({ "widgetId": "x", "message": { "type": "openUrl", "v": 1, "url": "javascript:alert(1)" } }),
            json!({ "widgetId": "x", "message": { "type": "resize", "v": 1, "h": 1e9 } }),
            json!({ "widgetId": "x", "message": { "type": "draftSend", "v": 1, "connector": "", "destination": "d", "body": "b" } }),
            json!({ "widgetId": "x", "message": { "type": "setState", "v": 1, "state": "not an object" } }),
            json!({ "widgetId": "x", "message": { "type": "setState", "v": 1, "state": { "k": "x".repeat(MAX_STATE_BYTES) } } }),
        ];
        for case in cases {
            assert!(
                matches!(post(case.clone()), Err(ActionError::Invalid(_))),
                "{case}"
            );
        }
        let huge = vec![b' '; MAX_BODY_BYTES + 1];
        assert_eq!(accept(&request(&huge), TOKEN), Err(ActionError::TooLarge));
    }
}
