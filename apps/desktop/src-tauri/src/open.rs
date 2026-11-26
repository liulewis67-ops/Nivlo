//! 打开外部资源的 Tauri 适配（`OpenPort`）：基于官方 opener 插件，只暴露受限的两个动作。

use stardeskbox_platform::error::PlatformError;
use stardeskbox_platform::open::{OpenPort, check_openable_url};
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

/// 基于 Tauri opener 插件的 [`OpenPort`]。
pub struct TauriOpen<R: Runtime> {
    /// 应用句柄。
    app: AppHandle<R>,
}

impl<R: Runtime> TauriOpen<R> {
    /// 创建。
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> OpenPort for TauriOpen<R> {
    /// 用默认浏览器打开 http(s) 网址；其他协议被拒绝。
    fn open_url(&self, url: &str) -> Result<(), PlatformError> {
        check_openable_url(url)?;
        self.app
            .opener()
            .open_url(url.trim(), None::<&str>)
            .map_err(|error| PlatformError::Failed(error.to_string()))
    }

    /// 在资源管理器里定位（选中）文件。
    fn reveal_file(&self, path: &str) -> Result<(), PlatformError> {
        if path.trim().is_empty() {
            return Err(PlatformError::Failed("路径为空".to_owned()));
        }
        self.app
            .opener()
            .reveal_item_in_dir(path)
            .map_err(|error| PlatformError::Failed(error.to_string()))
    }
}
