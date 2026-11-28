# 性能基线（实测）

测量脚本：`scripts/perf/measure.ps1`（实施计划 1.11 / 7.2）。测的是**已安装的 Release 构建**（NSIS 安装包安装后的 `asterjot-desktop.exe`），
全新的临时数据目录，进程树 = 主进程 + WebView2 子进程。

## 2026-10-12 · v0.1.1 · Windows 11（16 逻辑核）· 默认配置（无自定义皮肤）

| 指标 | 结果 | 预算 | 结论 |
| --- | --- | --- | --- |
| 冷启动到悬浮窗可见 | **378 ms**（另一次 447 ms） | 体感 < 1 s | 达标 |
| 空闲 CPU（10 分钟，进程树）平均 / 峰值 | **0.050% / 0.991%** | 平均 < 0.5% | 达标 |
| 内存（进程树工作集）起 / 终 | 379.8 MB / 511.4 MB（+34.6%） | 8 小时增长 < 10% | **未验证**（见下） |

内存曲线（逐分钟）：390 → 414 → 414 → **518（第 4 分钟一次性 +100 MB）** → 516 → 513 → 512 → 512 → 511 → 511。
10 分钟里只有一次台阶，之后持平略降，没有持续爬升；但 10 分钟不足以判断 8 小时的增长，

**台阶来源（逐进程复测，8 分钟，每分钟一次）**：AsterJot 主进程一直是 **38 MB（平的）**；WebView2 的浏览器 / GPU / utility 进程基本持平；台阶出现在第 7–8 分钟，是**多了一个渲染进程（renderer ×1 → ×2，+约 90 MB）并带动 GPU 进程 +20 MB**。多出来的渲染进程在两次测量里出现的时间不同（第 4 分钟 / 第 8 分钟），符合 Chromium「备用渲染进程」（spare renderer）的预热行为，但没有用 `--type` 之外的信息进一步确认它不是应用自己创建的第二个窗口。结论：**Rust 进程没有增长迹象，增长来自 WebView2 进程；8 小时长稳测试（`-Minutes 480`）仍然没做。**

## 2026-10-13 · 8 小时长稳（v0.1.1 发布构建，默认配置，全新数据目录）

| 指标 | 结果 | 预算 | 结论 |
| --- | --- | --- | --- |
| 持续时间 / 采样 | 8 小时，960 个采样（30 秒一次） | — | — |
| 空闲 CPU（进程树）平均 / 峰值 | **0.001% / 0.137%** | 平均 < 0.5% | 达标 |
| 内存（进程树工作集）起 / 终 | **391.5 MB / 387.8 MB（−0.9%）**，全程 387–394 MB | 8 小时增长 < 10% | **达标** |
| 崩溃 | 无（进程一直存活到测量脚本结束） | 无崩溃 | 达标 |
| 跨午夜 | 应用日志里 `day_changed date=2026-10-13` 在本地 00:00 准时出现 | — | 正常 |

这次没有出现 10 分钟测量里的 +100 MB 台阶（那次与第二个渲染进程出现有关）。每小时的内存读数都在 387–389 MB 之间，没有爬升。
**范围**：整晚机器处于空闲，没有休眠 / 唤醒，没有批量捕获，主窗口没有打开；24 小时、休眠唤醒与批量捕获的长稳仍未做。

## 2026-10-13 · 批量捕获压力（v0.1.1 发布构建，全新数据目录）

页面里循环调用 `capture`（文本、来路 paste）3000 次：**约 42.5–42.9 秒（≈ 14 ms / 次）**，AsterJot 主进程工作集 38 → 50 MB，进程树 380 → 430 MB，没有错误。

**发现并修复一个问题：SQLite 的 WAL 文件无界增长。** 3000 次捕获后数据库主文件才 1.4–1.9 MB，`asterjot.db-wal` 却有 **148–205 MB**，空闲 20 秒后也不回落——界面持续在读（每次捕获都会刷新计数），自动检查点没有机会重置 WAL，文件只增不减。修复：连接选项加 `journal_size_limit`（32 MiB），并新增 `Database::checkpoint()`（`PRAGMA wal_checkpoint(TRUNCATE)`）由宿主每 20 分钟调用一次；有回归测试（`a_checkpoint_shrinks_the_wal_after_heavy_writes_with_a_reader_in_the_way`：开着读事务写 4000 条后 WAL 明显变大，检查点之后被截断）。
修复后的真机复测：突发期间 WAL 峰值**仍然**达到 195 MB（读事务一直在，这点没变），但约 20 分钟后的定时检查点把它**截断到 0 字节**，主文件增长到 3.9 MB。所以这一步只做到「峰值有界且会回收」。

**压低峰值（已做）**：宿主订阅领域事件总线，每 100 个事件看一眼 WAL 大小，超过 16 MiB 就立刻 `checkpoint()`（`Database::checkpoint_if_wal_exceeds`，事件驱动，没有新增定时器；有回归测试 `the_wal_is_truncated_only_once_it_passes_the_limit`）。真机复测同样的 3000 次捕获（45.6 秒，无错误）：WAL 峰值 **25 MB**（之前 195 MB），结束后 5 秒内回到 **0 字节**，主文件 5.5 MB。

## 2026-10-27 · 搜索（含拼音首字母，release 构建，1 万条）

`crates/asterjot-storage/tests/search.rs` 的 `searching_ten_thousand_items_is_fast`，`cargo test --release -- --nocapture`：

| 查询 | 路径 | 耗时 | 命中 |
|---|---|---|---|
| 登录超时 | FTS | 0.9 ms | 1 |
| 登录 | LIKE 回退（2 字符） | 6.1 ms | 1 |
| 第 7776 条 | FTS | 0.2 ms | 1 |
| xfdlcs | FTS 无命中 + 拼音首字母 | 4.4 ms | 1 |
| ptdb | 拼音首字母命中全部行（取满 50 条） | 8.7 ms | 50 |
| zzqq | 两条路径都扫描、无命中（最坏情况） | 7.1 ms | 0 |

全部远低于 50 ms 的预算与 140 ms 的输入防抖；拼音首字母额外的一次查询最多多花约 7 ms，不需要索引。

## 2026-10-27 · 全局搜索框唤出（release 构建，`node tests/e2e/e2e.mjs --native`）

从 SendInput 松开快捷键的那一刻（PowerShell 记录的时间戳）到搜索框可见、`document.hasFocus()` 为真且焦点在输入框，5 轮：

| 场景 | 中位数 | 5 次 |
|---|---|---|
| 第一次唤出（创建窗口、加载页面；含测试的 CDP 连接） | 319 ms | 299 / 311 / 330 / 403 / 319 |
| 之后唤出（窗口已存在，只显示与聚焦） | 53 ms | 71 / 53 / 42 / 56 / 44 |

「之后 < 150 ms」的目标达成。

开启「预先准备全局搜索框」后（3 轮）：第一次唤出 **118 / 128 / 131 ms**，进程树工作集多 **约 92 MB**（3 轮都是 92 MB，预先创建前后各等 3 秒再测）。所以默认关闭，由用户选择。

## 2026-10-27 · Quick Create 输入就绪（release，3 轮）

从点「+ 待办」（CDP 点击）/ 按 Quick Create 快捷键（SendInput 松开）到输入框拿到真实焦点、可以打字：点击中位数 66–68 ms，快捷键 55–69 ms。「Hover → Enter 3 秒内」几乎全部留给人。

## 2026-10-27 · 按窗口拆分前端代码块

三个窗口共用一个 1.2 MB（gzip 379 KB）的入口，悬浮窗和搜索框也加载了主窗口的全部视图。现在按窗口 label 动态 `import()` 根组件：悬浮窗加载约 600 KB，搜索框约 550 KB，只有主窗口加载主窗口的块。

全局搜索框第一次唤出的分解（release，每种 3 次全新启动；日志事件 `search_window_created` / `search_window_page_loaded` 记录从开始创建算起的毫秒数，「可输入」是测试从按键到输入框拿到焦点）：

| | 创建窗口与 WebView | 页面加载完成并显示 | 可输入 |
|---|---|---|---|
| 不拆分 | 225 / 236 / 244 ms | 388 / 397 / 395 ms | 420 / 429 / 438 ms |
| 拆分 | 239 / 214 / 228 ms | 331 / 313 / 320 ms | 395 / 360 / 378 ms |

页面阶段快约 70 ms，可输入快约 50 ms。悬浮窗（启动 8 秒后 GC 再读）：JS 堆 3.3 → 2.3 MB，DOMContentLoaded 140–153 → 103–129 ms。

主窗口要多一次请求（先公共块、再主窗口块），但第一次打开（从请求打开到侧栏渲染出来，3 次全新启动）没有变慢：不拆分 537 / 544 / 457 ms，拆分 517 / 433 / 435 ms。

教训：第一次用 E2E 的计时比较时得出了相反的结论（380–441 对 359–380 ms），那组数字包含测试自己的 CDP 连接与轮询，噪声比差异还大；改用上面的日志分解后结论才可靠。剩下的大头是创建窗口与 WebView（约 230 ms），只有「预先准备全局搜索框」能省掉。

## 2026-10-27 · 脚本编辑器按需加载

主窗口的代码块里有 CodeMirror（只有 Workflow 的「脚本」页签用到）。改为 `React.lazy` 按需加载后：主窗口块 533 KB → 104 KB（gzip 172 → 26 KB），编辑器单独 429 KB，打开「脚本」页签时才下载。主窗口第一次打开（从请求打开到侧栏渲染，3 次全新启动）：之前 517 / 433 / 435 ms，现在 450 / 463 / 386 ms。

## 2026-11-02 · UI/UX M4 integrated release candidate

Command: `node tests/e2e/e2e.mjs --native --runs 3 --warm-runs 20 --zoom --badge-matrix`. [Measurements](../../tests/visual/stages/m4/native/measurements.json) include raw samples and source/executable hashes; [environment](../../tests/visual/stages/m4/environment.json) records Ryzen 7 5800H, 16GB RAM and one 1920×1080 monitor at 125%. Runtime: WebView2 Edge 156.0.4314.58. Database and WebView2 browser profiles are isolated per fixture.

Warm global search, from native hotkey release to focused input and document: 20 samples, median **47ms**, p95 **67ms**, below the 150ms budget. Cold activations remain separate: **238/310/287ms**, median **287ms**. Quick capture input-ready medians: pointer **50ms**, hotkey **29ms**. Prewarm first activation **28ms**, approximately **90MB** additional process-tree working set. Three complete native E2E runs and cold-main/prewarm scenarios passed.

The previous October search invocation figures used the same native key-release/focus endpoint but fewer runs; the new p95 has 20 warm samples. Hardware/profile/build differences limit direct causal attribution. These are system invocation times, not participant task completion times. M5 dense browser measurements are documented separately in its manifest; in-memory browser timers do not pass this native budget.

## Remaining measurements

* 启用循环皮肤 / 附加动效时的 CPU（D-13）；
* 24 小时长稳（含休眠唤醒、批量捕获；跨午夜已在 8 小时测量里覆盖）；
* 100% / 150% 缩放下的表现。
