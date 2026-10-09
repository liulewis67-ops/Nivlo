//! 悬浮窗的窗口行为 Port（架构文档 §10.3）。
//!
//! React 负责界面（Todo、动画、排序），Rust 负责窗口行为（位置、尺寸、置顶、焦点、显示器）。
//! 优先用 Tauri 实现；只有 No-Activate、特殊 HitTest 等能力不足时才进入平台 Adapter。

use crate::error::PlatformError;
use crate::placement::{MonitorInfo, Point, Rect};

/// 悬浮窗的目标区域（物理像素）。
pub type FloatingBounds = Rect;

/// 悬浮窗的窗口行为。
pub trait FloatingWindowPort: Send + Sync {
    /// 当前窗口的外框区域（物理像素）。
    ///
    /// # Errors
    ///
    /// 窗口已销毁或系统调用失败时返回 [`PlatformError::Failed`]。
    fn bounds(&self) -> Result<Rect, PlatformError>;

    /// 把窗口收起到徽标大小，保持左上角位置不变。
    ///
    /// # Errors
    ///
    /// 系统调用失败时返回 [`PlatformError::Failed`]。
    fn collapse(&self) -> Result<(), PlatformError>;

    /// 把窗口调整为 `bounds`（物理像素）。
    ///
    /// # Errors
    ///
    /// 系统调用失败时返回 [`PlatformError::Failed`]。
    fn expand(&self, bounds: FloatingBounds) -> Result<(), PlatformError>;

    /// 设置窗口是否可以获得焦点。
    ///
    /// 悬浮窗默认**不可聚焦**：Hover / 点击不能把焦点从用户正在使用的应用抢走；
    /// 只有 Quick Create 输入期间才临时开启（架构文档 §61 风险 3）。
    ///
    /// # Errors
    ///
    /// 平台不支持时返回 [`PlatformError::Unsupported`]，其他失败返回 [`PlatformError::Failed`]。
    fn set_focusable(&self, enabled: bool) -> Result<(), PlatformError>;

    /// 设置窗口是否置顶。
    ///
    /// # Errors
    ///
    /// 系统调用失败时返回 [`PlatformError::Failed`]。
    fn set_always_on_top(&self, enabled: bool) -> Result<(), PlatformError>;

    /// 把窗口左上角移动到 `position`（物理像素）。
    ///
    /// # Errors
    ///
    /// 系统调用失败时返回 [`PlatformError::Failed`]。
    fn move_to(&self, position: Point) -> Result<(), PlatformError>;

    /// 窗口当前所在的显示器。
    ///
    /// # Errors
    ///
    /// 无法确定所在显示器时返回 [`PlatformError::Failed`]。
    fn current_monitor(&self) -> Result<MonitorInfo, PlatformError>;

    /// 当前所有可用的显示器，主显示器的 `is_primary` 为 `true`。
    ///
    /// # Errors
    ///
    /// 系统调用失败时返回 [`PlatformError::Failed`]。
    fn monitors(&self) -> Result<Vec<MonitorInfo>, PlatformError>;
}
