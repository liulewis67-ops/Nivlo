//! 捕获时补充来源应用的规则测试。

use stardeskbox_domain::capture::{CaptureInput, CaptureOrigin, CaptureRequest};
use stardeskbox_platform::source_app::SourceApplicationPort;

use super::fill_source_application;

/// 固定返回某个应用的假识别。
struct Fixed(Option<&'static str>);

impl SourceApplicationPort for Fixed {
    fn source_application(&self) -> Option<String> {
        self.0.map(str::to_owned)
    }
}

fn request(origin: CaptureOrigin) -> CaptureRequest {
    CaptureRequest::new(
        CaptureInput::Text {
            text: "x".to_owned(),
        },
        origin,
    )
}

#[test]
fn drops_and_pastes_get_the_detected_source_application() {
    for origin in [CaptureOrigin::Drop, CaptureOrigin::Paste] {
        let mut r = request(origin);
        fill_source_application(&mut r, &Fixed(Some("Chrome")));
        assert_eq!(
            r.source_application.as_deref(),
            Some("Chrome"),
            "{origin:?}"
        );
    }
}

#[test]
fn self_authored_origins_never_record_a_source_application() {
    for origin in [
        CaptureOrigin::Manual,
        CaptureOrigin::QuickAdd,
        CaptureOrigin::Shortcut,
    ] {
        let mut r = request(origin);
        fill_source_application(&mut r, &Fixed(Some("Chrome")));
        assert_eq!(r.source_application, None, "{origin:?}");
    }
}

#[test]
fn an_explicit_value_is_kept_and_undetectable_apps_stay_empty() {
    let mut explicit = request(CaptureOrigin::Drop);
    explicit.source_application = Some("Custom".to_owned());
    fill_source_application(&mut explicit, &Fixed(Some("Chrome")));
    assert_eq!(explicit.source_application.as_deref(), Some("Custom"));

    let mut none = request(CaptureOrigin::Paste);
    fill_source_application(&mut none, &Fixed(None));
    assert_eq!(none.source_application, None);
}
