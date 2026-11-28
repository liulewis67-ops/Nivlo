//! 来源应用识别的平台选择与捕获时的接入（实施计划 10.4）。
//!
//! 只有**拖放**与**粘贴**——也就是内容来自别的应用的两种来路——才会识别来源应用；
//! 手动输入、快速添加、全局快捷键的内容是用户自己写的，不记录来源应用。

use std::sync::Arc;

use asterjot_domain::capture::{CaptureOrigin, CaptureRequest};
use asterjot_platform::source_app::SourceApplicationPort;

/// 当前平台的来源应用识别：Windows 用前台窗口钩子，其他平台暂不支持（总是 `None`）。
#[must_use]
pub fn platform_source_application() -> Arc<dyn SourceApplicationPort> {
    #[cfg(target_os = "windows")]
    {
        Arc::new(asterjot_platform_windows::source_app::WindowsSourceApplication)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Arc::new(NoSourceApplication)
    }
}

/// 不支持来源应用识别的平台。
#[cfg(not(target_os = "windows"))]
struct NoSourceApplication;

#[cfg(not(target_os = "windows"))]
impl SourceApplicationPort for NoSourceApplication {
    /// 总是识别不到。
    fn source_application(&self) -> Option<String> {
        None
    }
}

/// 来路是不是「内容来自别的应用」。
fn comes_from_another_app(origin: CaptureOrigin) -> bool {
    matches!(origin, CaptureOrigin::Drop | CaptureOrigin::Paste)
}

/// 给来自别的应用的捕获补上来源应用；已经有值（调用方明确给了）时保持不变。
pub fn fill_source_application(request: &mut CaptureRequest, port: &dyn SourceApplicationPort) {
    if request.source_application.is_none() && comes_from_another_app(request.origin) {
        request.source_application = port.source_application();
    }
}

#[cfg(test)]
mod tests;
