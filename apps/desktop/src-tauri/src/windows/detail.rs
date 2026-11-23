//! 每个事项一个独立详情窗口；同一事项重复打开时复用原窗口及其草稿。

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// 独立详情窗口的 label 前缀。
pub const DETAIL_WINDOW_PREFIX: &str = "detail-";

/// 根据已经校验的事项 ID 构造稳定窗口标识。
fn window_label(item_id: &str) -> String {
    format!("{DETAIL_WINDOW_PREFIX}{item_id}")
}

/// 打开独立详情窗口；原生关闭由前端等待草稿保存后销毁窗口。
///
/// # Errors
/// 原生窗口创建、显示或聚焦失败时返回 Tauri 错误。
pub fn show<R: Runtime>(app: &AppHandle<R>, item_id: &str) -> tauri::Result<()> {
    let label = window_label(item_id);
    let window = match app.get_webview_window(&label) {
        Some(window) => window,
        None => {
            let url = format!("index.html?window=detail&item={item_id}");
            let monitor = app
                .get_webview_window(super::MAIN_WINDOW_LABEL)
                .or_else(|| app.get_webview_window(super::FLOATING_WINDOW_LABEL))
                .and_then(|window| window.current_monitor().ok().flatten());
            let (width, height) = monitor.as_ref().map_or((680.0, 800.0), |monitor| {
                let area = monitor.work_area();
                let scale = monitor.scale_factor();
                (
                    (f64::from(area.size.width) / scale - 32.0).clamp(240.0, 680.0),
                    (f64::from(area.size.height) / scale - 64.0).clamp(240.0, 800.0),
                )
            });
            WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
                .title("Nivlo")
                .inner_size(width, height)
                .min_inner_size(width.min(400.0), height.min(360.0))
                .decorations(true)
                .visible(false)
                .center()
                .zoom_hotkeys_enabled(cfg!(target_os = "windows"))
                .disable_drag_drop_handler()
                .build()
                .inspect(super::suppress_bare_alt_menu)?
        }
    };
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_item_reuses_label_and_different_items_are_independent() {
        assert_eq!(window_label("a"), window_label("a"));
        assert_ne!(window_label("a"), window_label("b"));
        assert!(window_label("a").starts_with(DETAIL_WINDOW_PREFIX));
    }

    #[test]
    fn opens_reuses_and_separates_actual_mock_windows() -> tauri::Result<()> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))?;
        show(app.handle(), "first")?;
        show(app.handle(), "first")?;
        assert_eq!(app.webview_windows().len(), 1);
        show(app.handle(), "second")?;
        assert_eq!(app.webview_windows().len(), 2);
        assert!(app.get_webview_window("main").is_none());
        Ok(())
    }
}
