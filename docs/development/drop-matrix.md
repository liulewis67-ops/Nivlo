# 拖放兼容矩阵（实施计划 2.4）

方案见 [ADR-011](../adr/011-html5-drop-on-floating-window.md)：悬浮窗使用 HTML5 Drop。

**状态说明**：「单测」= 提取逻辑已由 `extract-drop.test.ts` / `drop-capture.test.tsx` 用对应的 `DataTransfer` 形状验证；「待真机」= 需要在 Windows 11 + WebView2 上手动拖放确认，**目前尚未执行**，不能当作已通过。

| 来源 | 预期的 DataTransfer | 预期结果 | 单测 | 真机 |
|---|---|---|---|---|
| Chrome 页面链接 | `text/uri-list`、`text/plain` | 网址 → Note | ✅ | 待真机 |
| Edge 页面链接 | `text/uri-list`、`text/plain` | 网址 → Note | ✅ | 待真机 |
| Firefox 页面链接 | `text/x-moz-url`、`text/uri-list` | 网址 → Note | ✅ | 待真机 |
| Chrome / Edge 地址栏图标 | `text/uri-list` | 网址 → Note | ✅ | 待真机 |
| 浏览器中选中的文本 | `text/plain`（+ `text/html`） | 文本 → Todo（单个网址则 Note） | ✅ | 待真机 |
| 浏览器中的图片 | `Files`（image/*）+ `text/uri-list` | 图片 → Note（附件） | ✅ | 待真机 |
| VS Code 选中文本 | `text/plain` | 文本 → Todo | ✅ | 待真机 |
| Word 选中文本 | `text/plain`（+ `text/html` / RTF） | 文本 → Todo | ✅ | 待真机 |
| 资源管理器：图片文件 | `Files`（image/*） | 图片 → Note（附件） | ✅ | 待真机 |
| 资源管理器：单个非图片文件 | `Files`，页面里无路径；经 WebView2 `postMessageWithAdditionalObjects` 由宿主取路径 | 文件引用 → Note | ✅ | 路径通道已在真机验证（含中文与空格路径），**真实的资源管理器拖动未做** |
| 资源管理器：多个文件 | 同上（`AdditionalObjects` 按顺序给出每个文件的路径） | 多个文件引用 | ✅（单测） | 未验证（真机只测了单文件） |
| 资源管理器：文件夹 | `Files`（0 字节、无类型） | 尝试取路径 | 未覆盖 | **未验证**：不知道 WebView2 对文件夹给出的 `File` 能否取到路径 |

## 替代路径：粘贴（实施计划 2.5）

资源管理器里的文件在 HTML5 Drop 里拿不到磁盘路径，但**复制文件后点悬浮窗的「粘贴」（或在主窗口收集箱按 Ctrl+V）**可以收集：剪贴板的 `CF_HDROP` 带完整路径（含中文与空格，多文件一次收进，已用真实系统剪贴板测试）。在 10.1 的 Native Drop 之前，文件的推荐路径是复制 → 粘贴，拖入时的提示文案也是这么引导的。

## 10.1 实现方式（2026-10-12）

不做自定义 `IDropTarget`：真机探测发现 WebView2 的拖放目标注册在**浏览器进程**的窗口上（另一个进程），本进程无法接管或转发。改用 WebView2 的正式接口：页面把拖入的 `File` 对象用 `chrome.webview.postMessageWithAdditionalObjects("nivlo:drop-files:<id>", files)` 交给宿主，宿主在 `WebMessageReceived` 里从 `ICoreWebView2File.Path` 取出磁盘路径，经 Tauri 事件 `nivlo-drop-paths` 发回页面，页面再以 `files` 输入捕获。HTML5 的链接 / 文本 / 图片拖放完全不受影响。真机验证方式：用调试端口把一个真实文件挂到 `<input type=file>`，再派发携带该 `File` 的 `drop` 事件，得到「已创建：<文件名>」，日志里 `capture_completed kind=file origin=drop`。

## 10.1 的输入（历史）

- 资源管理器的文件 / 多文件 / 文件夹：HTML5 Drop 拿不到磁盘路径，需要 Native Drop（`IDropTarget` + `CF_HDROP`）。这一项属于 MVP 必须有的「拖入文件」，实施计划 D-15 建议提前到 M4 发布前完成。
- 真机验证后，把「待真机」替换为实测结果，并把所有失败项补充到这里。
