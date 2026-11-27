# 悬浮框新增配置页本机开发验证

日期：2026-11-05（Asia/Shanghai）。范围：当前工作区、本机 Windows，无额外机器或显示器资源。

## 本次补充

- 表单测试增加非空项目随一次完整创建提交，待办切换为笔记再切回后恢复简述、截止时间、优先级和项目。
- 增加空白标题不能提交，以及清空计划日期后时间被清除并禁用的测试。
- 配置模式的 Rust 测试实际替换模拟显示器集合：从负坐标、150% 小工作区切换至另一块 200% 工作区，验证重新居中、输入状态不变、取消后徽标处于现存工作区内。
- 配置页标题占位提示改为独立中英文文案，避免旧的“Enter 创建”提示与 Ctrl+Enter 提交行为冲突。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| 前端 Prettier、TypeScript、ESLint | 通过 |
| 前端全量 Vitest | 69 个文件、704 项测试通过（第二轮优化后） |
| 前端生产构建 | 通过；仍有构建产物大于 500 kB 的体积提示 |
| Rust `cargo fmt --all --check` | 通过 |
| Rust `cargo clippy -p starat-desktop --all-targets -j 2 -- -D warnings` | 通过 |
| Rust 悬浮控制器测试 | 34 项通过 |
| Rust capability 测试 | 7 项通过 |
| 配置页浏览器视觉场景 | 5 项通过；第二轮因底栏新增“继续新增”选项更新基线，复跑差异均为 0% |

复现命令（仓库根目录，Windows 使用 npm.cmd）：

```powershell
npm.cmd --prefix apps/desktop/ui run check
npm.cmd --prefix apps/desktop/ui run build
cargo fmt --all --check
cargo clippy -p starat-desktop --all-targets -j 2 -- -D warnings
cargo test -p starat-desktop windows::floating::tests -j 2
cargo test -p starat-desktop --test capabilities -j 2
node scripts/visual/visual.mjs --create-stage
```

视觉截图及 manifest 位于 `apps/desktop/ui/.impeccable/review/`。浏览器通过不代表原生几何、系统焦点或物理输入法通过。

## 第二轮优化补充测试

- 今天日期晚到时补上默认日期，未改动草稿 Escape 直接关闭。
- 笔记切到待办补今天；用户清空的日期在切换类型后不被覆盖。
- 连续新增两次：项目和日期保留，标题与描述清空，状态提示随下一次输入消失，最终取消不弹确认。
- 配置页已打开时再次触发快速添加：窗口无焦点时重新调用 `beginFloatingInput(true)`，草稿与“笔记”类型保留。

第二轮仅前端改动，未改 Rust，沿用 2026-11-05 0:05 编译、晚于全部 Rust 源码修改的 `target/debug/starat-desktop.exe`。

### 第二轮本机原生实测

隔离数据目录 `%TEMP%/starat-create-r2-20261105`、WebView2 目录 `%TEMP%/starat-create-r2-webview-20261105`；通过 CDP 读写页面状态，用 `keybd_event` 发送真实的 Ctrl+Shift+Space 全局快捷键，用 `GetForegroundWindow` 确认前台窗口。测试实例已退出。

| 场景 | 观察结果 |
| --- | --- |
| 前台为其他应用时按快捷键首次打开 | 配置页位于 `(448,48)`、640×720，前台切到 StarAt，焦点在标题，默认计划日期为当天 |
| 已打开、选“笔记”并填写标题后切到其他应用，再按快捷键 | 前台回到 StarAt，`document.hasFocus()` 为 true，焦点在标题；标题与“笔记”类型保留，位置不变 |
| 勾选“创建后继续新增”，计划日期改为 2026-11-07，连续创建两次 | 配置页保持打开，显示“已创建「…」”，标题清空并聚焦，日期保留；输入下一条标题时提示消失 |
| 空白续录按 Escape | 不弹放弃确认直接关闭；徽标回到 `(1472,62)`，前台还给原应用 |
| 持久化结果 | 只读查询真实 `items` 表：恰好 2 条 todo（连续一、连续二），计划日期均为 2026-11-07，无多余记录 |

首次尝试时前台为刚启动、正在恢复标签页的 Notepad，配置页打开但前台仍是 Notepad；复测（前台分别为控制台和已就绪的 Notepad）均正常取得焦点，未能复现，判断为 Notepad 启动过程抢回前台。字段值通过 CDP 写入，物理键盘与输入法输入不在本轮范围。

## 本机原生实测

使用重新编译的 `target/debug/starat-desktop.exe`、真实 Tauri IPC、WebView2 及 SQLite；开发服务器提供前端。运行时确认 `window.__TAURI_INTERNALS__` 存在，未使用浏览器 Memory IPC。UI 通过 computer-use 操作，运行时几何和数据库通过只读检查确认。

数据目录为 `%TEMP%/starat-create-validation-20261105`，WebView2 目录为 `%TEMP%/starat-create-validation-webview-20261105`。测试实例已退出，未使用日常数据目录。

| 场景 | 观察结果 |
| --- | --- |
| 从 Today 的“+ 待办”进入 | 显示完整配置页，可以输入标题 |
| 工作区与缩放 | `devicePixelRatio=1.25`；屏幕 1536×864、工作区 1536×816 logical px |
| 配置几何 | `(448,48)`、640×720 logical px；两方向均满足工作区居中公式 |
| 原生文字输入 | 标题输入“本机开发验证 2026-11-05”成功 |
| 切换至其他应用 | 草稿保留；返回后仍可操作 |
| Escape 取消已编辑草稿 | 出现放弃确认，字段禁用；继续编辑后标题保留 |
| Ctrl+Enter 创建 | 创建成功，配置页关闭，返回悬浮徽标，计数变为 1 |
| 持久化结果 | 只读查询真实 `items` 表确认恰好 1 条 todo，标题正确，计划日期为 2026-11-05 |
| 全局快捷键 | Ctrl+Shift+Space 再次唤起完整配置页；空白草稿 Escape 取消，无额外记录 |
| 徽标恢复 | 两次退出配置后均回到右侧徽标；观测物理位置 `(1840,78)`，运行时 logical 位置约 `(1472,62)` |

原生测试过程中，运行中的 exe 曾阻止 Cargo 覆写文件。退出隔离测试实例后重跑 Rust 测试通过；该错误来自 Windows 文件占用，不是测试断言失败。

## 覆盖边界

按用户指定的本机资源范围完成开发验收，不要求额外设备。多屏/物理拔屏/混合 DPI 迁移仅有模拟测试证据；本机仅实测现有 125% 显示配置。真实托盘菜单点击未单独操作，全局快捷键与托盘共用后端 `request_quick_add` 路由，入口接入由组件测试覆盖。完整字段、项目、失败重试、防重复和输入法组合事件由自动测试覆盖；本机原生只实测标题及默认计划日期的实际写入，没有宣称所有字段或物理输入法均原生通过。

本次未执行全工作区 Rust 测试、安装包安装或发布；已完成桌面包构建、受影响控制器和权限测试及桌面包所有 target 的 Clippy。

## 笔记文档布局的本机验证（2026-11-05）

发布版（`vite build` + `cargo build --release --features tauri/custom-protocol`），临时 `STARAT_DATA_DIR` 与 `WEBVIEW2_USER_DATA_FOLDER`，通过 CDP 驱动真实窗口；运行前确认没有其他 StarAt 实例，结束后关闭测试进程并删除临时目录。显示器：125% 缩放，logical 工作区 1536×816。

| 检查 | 结果 |
|---|---|
| 从面板点「+ 笔记」 | 打开「新增笔记」，窗口 960×784 logical（高度按工作区减去边距缩小），水平居中；标题拿到原生键盘焦点 |
| 标题里按 Enter | 焦点进入正文 |
| Markdown 任务行 Ctrl+Enter | `- [ ]` 变成 `- [x]`，没有创建，配置页仍打开 |
| 切到待办 | 窗口变为 640×720，标题和正文保留 |
| 切回笔记 | 窗口回到 960×784，键盘焦点仍在窗口内 |
| 点「创建」 | 配置页关闭，徽标回到原来的位置 (1472, 62)、64×32 |
| 持久化结果 | 主窗口 `list_items` 查到这条笔记：`contentFormat` 为 `markdown`，正文为 `- [x] 第一项任务`，没有日期 |

拖入网页 / 文件到打开的笔记页、深色主题和窄屏下的侧栏下移只在浏览器预览与组件测试中验证。
