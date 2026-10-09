//! 基于 Tauri 的 [`FloatingWindowPort`] 实现。
//!
//! Tauri 能满足悬浮窗当前的全部需求（位置、尺寸、置顶、可聚焦）；
//! 只有 No-Activate、特殊 HitTest 等能力不足时才需要平台 Adapter（实施计划 10.2）。

use nivlo_platform::error::PlatformError;
use nivlo_platform::floating_window::{FloatingBounds, FloatingWindowPort};
use nivlo_platform::placement::{
    COLLAPSED_HEIGHT_LOGICAL_PX, COLLAPSED_WIDTH_LOGICAL_PX, MonitorInfo, Point, Rect,
};
use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

/// 把任意 Tauri 错误转换为 [`PlatformError::Failed`]，不向上泄漏 Tauri 的错误类型。
fn failed(error: impl std::fmt::Display) -> PlatformError {
    PlatformError::Failed(error.to_string())
}

/// 把 Tauri 的显示器转换为与窗口库无关的 [`MonitorInfo`]。
///
/// 显示器标识优先使用系统名称（如 `\\.\DISPLAY2`），没有名称时用分辨率与位置拼出一个稳定的标识。
fn to_monitor_info(monitor: &tauri::Monitor, primary: Option<&tauri::Monitor>) -> MonitorInfo {
    let work = monitor.work_area();
    let position = monitor.position();
    let size = monitor.size();
    let id = monitor.name().cloned().unwrap_or_else(|| {
        format!(
            "{}x{}@{},{}",
            size.width, size.height, position.x, position.y
        )
    });
    let is_primary = primary.is_some_and(|p| p.position() == position && p.size() == size);
    MonitorInfo {
        id,
        work_area: Rect {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
            height: work.size.height,
        },
        scale_factor: monitor.scale_factor(),
        is_primary,
    }
}

/// 包装悬浮窗对应的 `WebviewWindow`，实现 [`FloatingWindowPort`]。
pub struct TauriFloatingWindow<R: Runtime> {
    /// 悬浮窗。
    window: WebviewWindow<R>,
}

impl<R: Runtime> TauriFloatingWindow<R> {
    /// 包装悬浮窗。
    pub fn new(window: WebviewWindow<R>) -> Self {
        Self { window }
    }
}

impl<R: Runtime> FloatingWindowPort for TauriFloatingWindow<R> {
    /// 窗口外框（物理像素）。
    fn bounds(&self) -> Result<Rect, PlatformError> {
        let position = self.window.outer_position().map_err(failed)?;
        let size = self.window.outer_size().map_err(failed)?;
        Ok(Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        })
    }

    /// 收起为徽标大小：尺寸按窗口当前所在显示器的缩放换算，保持左上角不动。
    fn collapse(&self) -> Result<(), PlatformError> {
        let scale = self.window.scale_factor().map_err(failed)?;
        // 徽标尺寸为几十 logical px，乘以缩放后远小于 u32 上限，转换不会截断。
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let size = PhysicalSize::new(
            (COLLAPSED_WIDTH_LOGICAL_PX * scale).round() as u32,
            (COLLAPSED_HEIGHT_LOGICAL_PX * scale).round() as u32,
        );
        self.window.set_size(size).map_err(failed)
    }

    /// 调整窗口位置与尺寸。
    fn expand(&self, bounds: FloatingBounds) -> Result<(), PlatformError> {
        self.window
            .set_size(PhysicalSize::new(bounds.width, bounds.height))
            .map_err(failed)?;
        self.window
            .set_position(PhysicalPosition::new(bounds.x, bounds.y))
            .map_err(failed)
    }

    /// 设置是否可聚焦。
    fn set_focusable(&self, enabled: bool) -> Result<(), PlatformError> {
        self.window.set_focusable(enabled).map_err(failed)
    }

    /// 设置是否置顶。
    fn set_always_on_top(&self, enabled: bool) -> Result<(), PlatformError> {
        self.window.set_always_on_top(enabled).map_err(failed)
    }

    /// 移动窗口左上角。
    fn move_to(&self, position: Point) -> Result<(), PlatformError> {
        self.window
            .set_position(PhysicalPosition::new(position.x, position.y))
            .map_err(failed)
    }

    /// 指针的屏幕位置（取整为物理像素）。
    fn cursor_position(&self) -> Result<Point, PlatformError> {
        let position = self.window.cursor_position().map_err(failed)?;
        // 屏幕坐标远小于 i32 范围，四舍五入后转换不会截断。
        #[allow(clippy::cast_possible_truncation)]
        Ok(Point {
            x: position.x.round() as i32,
            y: position.y.round() as i32,
        })
    }

    /// 窗口所在的显示器。
    fn current_monitor(&self) -> Result<MonitorInfo, PlatformError> {
        let current = self
            .window
            .current_monitor()
            .map_err(failed)?
            .ok_or_else(|| PlatformError::Failed("窗口不在任何显示器上".to_owned()))?;
        let primary = self.window.primary_monitor().map_err(failed)?;
        Ok(to_monitor_info(&current, primary.as_ref()))
    }

    /// 全部显示器。
    fn monitors(&self) -> Result<Vec<MonitorInfo>, PlatformError> {
        let primary = self.window.primary_monitor().map_err(failed)?;
        let monitors = self.window.available_monitors().map_err(failed)?;
        Ok(monitors
            .iter()
            .map(|m| to_monitor_info(m, primary.as_ref()))
            .collect())
    }
}
