//! 从 WebView2 取拖入文件的磁盘路径（实施计划 10.1，D-15）。
//!
//! 悬浮窗用 HTML5 Drop（ADR-011），资源管理器拖来的文件在页面里只是没有路径的 `File` 对象，
//! 而 WebView2 的拖放目标在浏览器进程里，无法从本进程接管。WebView2 为此提供了正式的接口：
//! 页面调用 `chrome.webview.postMessageWithAdditionalObjects(消息, [File...])`，
//! 宿主在 `WebMessageReceived` 里通过 `AdditionalObjects` 拿到 `ICoreWebView2File`，其 `Path` 就是磁盘路径。
//!
//! 只响应以 [`MESSAGE_PREFIX`] 开头的消息；路径只来自用户拖入的 `File` 对象，页面不能指定任意路径。

// 本模块含 COM 调用（后端规范 §9.4）：每个 `unsafe` 块都有 SAFETY 注释。
#![allow(unsafe_code)]

use std::sync::Arc;

use nivlo_platform::error::PlatformError;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
    ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
use windows::core::{Interface, PWSTR};

/// 页面发来的消息前缀：`nivlo:drop-files:<关联 ID>`。
pub const MESSAGE_PREFIX: &str = "nivlo:drop-files:";

/// 收到拖入文件路径时的回调：（页面给的关联 ID，磁盘路径）。在 WebView 所在线程调用，必须很快返回。
pub type DropCallback = Arc<dyn Fn(String, Vec<String>) + Send + Sync>;

/// 从消息文本里取出关联 ID；不是本模块的消息返回 `None`。
/// 关联 ID 只允许字母、数字、`-`、`_`，且不超过 64 个字符。
#[must_use]
pub fn parse_message(message: &str) -> Option<String> {
    let id = message.strip_prefix(MESSAGE_PREFIX)?;
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
    valid.then(|| id.to_owned())
}

/// 从事件参数里取出全部 `File` 的路径。
fn paths_of(args: &ICoreWebView2WebMessageReceivedEventArgs) -> windows::core::Result<Vec<String>> {
    let args2: ICoreWebView2WebMessageReceivedEventArgs2 = args.cast()?;
    // SAFETY: 以下都是 WebView2 COM 接口的同步调用，参数是有效的输出指针；
    // 返回的字符串由 `take_pwstr` 取走并释放。
    unsafe {
        let objects = args2.AdditionalObjects()?;
        let mut count = 0_u32;
        objects.Count(&raw mut count)?;
        let mut paths = Vec::new();
        for index in 0..count {
            let item = objects.GetValueAtIndex(index)?;
            let Ok(file) = item.cast::<ICoreWebView2File>() else {
                continue;
            };
            let mut raw = PWSTR::null();
            file.Path(&raw mut raw)?;
            paths.push(take_pwstr(raw));
        }
        Ok(paths)
    }
}

/// 在 WebView 上监听拖入文件的路径。必须在拥有该 WebView 的线程（Tauri 主线程）上调用。
///
/// # Errors
///
/// 取不到 `CoreWebView2` 或注册失败时返回 [`PlatformError::Failed`]。
pub fn watch_file_drops(
    controller: &ICoreWebView2Controller,
    callback: DropCallback,
) -> Result<(), PlatformError> {
    // SAFETY: 调用方保证在 WebView 所在线程上调用，控制器有效；`token` 是有效的输出指针，
    // 处理器随 WebView 存活。
    let result = unsafe {
        controller.CoreWebView2().and_then(|core| {
            let mut token = 0_i64;
            core.add_WebMessageReceived(
                &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut raw = PWSTR::null();
                    // 不是字符串消息（或不是本模块的消息）时直接忽略。
                    if args.TryGetWebMessageAsString(&raw mut raw).is_err() {
                        return Ok(());
                    }
                    let message = take_pwstr(raw);
                    let Some(id) = parse_message(&message) else {
                        return Ok(());
                    };
                    callback(id, paths_of(&args).unwrap_or_default());
                    Ok(())
                })),
                &raw mut token,
            )
        })
    };
    result.map_err(|e| PlatformError::Failed(format!("无法监听拖入的文件路径：{e}")))
}

#[cfg(test)]
mod tests {
    use super::{MESSAGE_PREFIX, parse_message};

    #[test]
    fn only_well_formed_drop_messages_are_accepted() {
        assert_eq!(
            parse_message("nivlo:drop-files:abc-123_X").as_deref(),
            Some("abc-123_X")
        );
        let too_long = format!("{MESSAGE_PREFIX}{}", "a".repeat(65));
        for bad in [
            "",
            "hello",
            "nivlo:drop-files:",
            "nivlo:drop-files:a b",
            "nivlo:drop-files:../x",
            "nivlo:other:abc",
            too_long.as_str(),
        ] {
            assert_eq!(parse_message(bad), None, "{bad:?}");
        }
    }
}
