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
| 资源管理器：单个非图片文件 | `Files`，**无磁盘路径** | 提示暂不支持 | ✅（提示） | 预期失败 → 10.1 |
| 资源管理器：多个文件 | `Files`，**无磁盘路径** | 提示暂不支持 | ✅（提示） | 预期失败 → 10.1 |
| 资源管理器：文件夹 | `Files`（0 字节、无类型） | 提示暂不支持 | ✅（提示） | 预期失败 → 10.1 |

## 替代路径：粘贴（实施计划 2.5）

资源管理器里的文件在 HTML5 Drop 里拿不到磁盘路径，但**复制文件后点悬浮窗的「粘贴」（或在主窗口收集箱按 Ctrl+V）**可以收集：剪贴板的 `CF_HDROP` 带完整路径（含中文与空格，多文件一次收进，已用真实系统剪贴板测试）。在 10.1 的 Native Drop 之前，文件的推荐路径是复制 → 粘贴，拖入时的提示文案也是这么引导的。

## 10.1 的输入

- 资源管理器的文件 / 多文件 / 文件夹：HTML5 Drop 拿不到磁盘路径，需要 Native Drop（`IDropTarget` + `CF_HDROP`）。这一项属于 MVP 必须有的「拖入文件」，实施计划 D-15 建议提前到 M4 发布前完成。
- 真机验证后，把「待真机」替换为实测结果，并把所有失败项补充到这里。
