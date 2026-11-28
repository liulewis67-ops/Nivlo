//! 全局快捷键触发的文本预填。

use std::future::Future;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Wry};
use tauri_specta::Event;

use crate::events::{ContextCreateRequestedEvent, ContextCreateSource};

/// 只交付最后一次请求的结果。
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// 获取单个来源结果的时间预算。
const READ_TIMEOUT: Duration = Duration::from_millis(400);

/// 取消尚未送到创建窗口的结果。
pub(crate) fn cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// 捕获触发时的前台窗口，异步读取选区或剪贴板，再唤起悬浮窗。
pub(crate) fn request(app: &AppHandle<Wry>) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let app = app.clone();
    #[cfg(target_os = "windows")]
    let focus = asterjot_platform_windows::selection::foreground_focus();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        return asterjot_platform_windows::selection::read_selection(focus);
        #[cfg(not(target_os = "windows"))]
        Option::<String>::None
    });
    tauri::async_runtime::spawn(async move {
        let is_current = || GENERATION.load(Ordering::SeqCst) == generation;
        let Some(event) = resolve_text(
            async { selection.await.ok().flatten() },
            clipboard_result(),
            is_current,
        )
        .await
        else {
            return;
        };
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        crate::tray::set_floating_visible(&app, true);
        if let Err(error) = event.emit_to(&app, crate::windows::FLOATING_WINDOW_LABEL) {
            tracing::warn!(event = "context_create_request_failed", %error, "请求预填新增失败");
        }
    });
}

/// 先尝试当前选区；只有仍有效的请求才允许读取剪贴板或交付结果。
async fn resolve_text(
    selection: impl Future<Output = Option<String>>,
    clipboard: impl Future<Output = ContextCreateRequestedEvent>,
    is_current: impl Fn() -> bool,
) -> Option<ContextCreateRequestedEvent> {
    let selected = tokio::time::timeout(READ_TIMEOUT, selection)
        .await
        .ok()
        .flatten();
    if !is_current() {
        return None;
    }
    let event = if let Some(text) = selected.filter(|text| !text.trim().is_empty()) {
        ContextCreateRequestedEvent {
            text: Some(text),
            source: ContextCreateSource::Selection,
        }
    } else {
        tokio::time::timeout(READ_TIMEOUT, clipboard)
            .await
            .unwrap_or(ContextCreateRequestedEvent {
                text: None,
                source: ContextCreateSource::Unavailable,
            })
    };
    is_current().then_some(event)
}

/// 只读取剪贴板文本，保留缺少文本与无法读取的不同状态。
async fn clipboard_result() -> ContextCreateRequestedEvent {
    let result = tauri::async_runtime::spawn_blocking(|| {
        static READING: Mutex<()> = Mutex::new(());
        let _reading = READING.try_lock().ok()?;
        crate::clipboard::platform_clipboard().read_text().ok()
    })
    .await;
    match result {
        Ok(Some(Some(text))) if !text.trim().is_empty() => ContextCreateRequestedEvent {
            text: Some(text),
            source: ContextCreateSource::Clipboard,
        },
        Ok(Some(_)) => ContextCreateRequestedEvent {
            text: None,
            source: ContextCreateSource::Empty,
        },
        _ => ContextCreateRequestedEvent {
            text: None,
            source: ContextCreateSource::Unavailable,
        },
    }
}

#[cfg(test)]
mod tests {
    //! 快捷键来源优先级与请求失效测试。

    use std::cell::Cell;
    use std::future::{pending, ready};

    use super::*;

    #[tokio::test]
    async fn selection_wins_without_reading_the_clipboard() {
        let clipboard_read = Cell::new(false);
        let result = resolve_text(
            ready(Some("新消息\n原文".to_owned())),
            async {
                clipboard_read.set(true);
                clipboard_event()
            },
            || true,
        )
        .await;
        assert_eq!(
            result.and_then(|event| event.text).as_deref(),
            Some("新消息\n原文")
        );
        assert!(!clipboard_read.get());
    }

    #[tokio::test(start_paused = true)]
    async fn slow_selection_falls_back_to_the_clipboard() {
        let event = resolve_text(pending(), ready(clipboard_event()), || true).await;
        assert!(matches!(
            event,
            Some(ContextCreateRequestedEvent {
                source: ContextCreateSource::Clipboard,
                ..
            })
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn slow_clipboard_opens_an_empty_draft_with_a_read_error() {
        let event = resolve_text(ready(None), pending(), || true).await;
        assert!(matches!(
            event,
            Some(ContextCreateRequestedEvent {
                text: None,
                source: ContextCreateSource::Unavailable,
            })
        ));
    }

    #[tokio::test]
    async fn an_obsolete_selection_never_falls_back_to_clipboard() {
        let clipboard_read = Cell::new(false);
        let event = resolve_text(
            ready(None),
            async {
                clipboard_read.set(true);
                clipboard_event()
            },
            || false,
        )
        .await;
        assert!(event.is_none());
        assert!(!clipboard_read.get());
    }

    #[tokio::test]
    async fn a_clipboard_read_completed_after_cancel_is_discarded() {
        let current = Cell::new(true);
        let event = resolve_text(
            ready(None),
            async {
                current.set(false);
                clipboard_event()
            },
            || current.get(),
        )
        .await;
        assert!(event.is_none());
    }

    /// 模拟从系统剪贴板读取上一条消息。
    fn clipboard_event() -> ContextCreateRequestedEvent {
        ContextCreateRequestedEvent {
            text: Some("旧消息".to_owned()),
            source: ContextCreateSource::Clipboard,
        }
    }
}
