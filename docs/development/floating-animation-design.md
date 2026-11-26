# 悬浮窗动画设置、机器人动作与本地文件帧动画设计方案

> 状态：已完成全部三阶段实施
> 适用范围：`apps/desktop/ui`、`apps/desktop/src-tauri`、`crates/stardeskbox-common`、`crates/stardeskbox-storage`

---

## 1. 背景与目标

当前 StarDeskBox 悬浮窗在收起态支持三种显示模式（`robot` / `image` / `badge`），但动画与定制能力存在以下不足：

1. **缺少全局动画开关与机器人动作配置**：内置机器人（`RobotAvatar`）仅有悬停上移 `1px` 与提醒闪烁，设置页中“皮肤动画”仅在 `mode === "image"` 时可见，用户无法配置机器人动作，也无法一键关闭悬浮窗动画。
2. **自定义帧动画能力与存储受限**：
   - 现有帧图以 PNG Base64 直接内联在 `ui.skin`（SQLite 上限 4 MiB + `localStorage` 约 5 MiB），限制了单帧分辨率（96px）与总帧数（16 帧）。
   - 仅支持单一扁平帧列表，无法按交互状态（待机 / 悬停 / 拖拽 / 拖放就绪 / 全部完成 / 提醒）切换动作。
   - GIF 仅取首帧，不支持精灵图（Sprite Sheet）切帧、帧排序与单帧独立时长。

**本次设计目标**：
- 在设置页提供**悬浮窗动画总开关**与**触发策略**，支持随时关闭全部动画。
- 为内置悬浮机器人提供**可配置、可关闭的动作体系**（待机动作 + 交互反馈动作）。
- 从一开始就将自定义帧动画素材改为**本地文件存储**（内容寻址 + 自定义只读协议加载），解除 `localStorage`/SQLite 体积瓶颈，支持更高分辨率与更多帧数。
- 建立**统一的帧动画引擎**，同时驱动内置机器人与用户自定义皮肤，并兼容已有配置平滑迁移。

---

## 2. 架构约束与设计原则

1. **透明窗口防裁切**：收起态悬浮窗为紧贴内容的透明原生窗口（机器人 `80×40`、皮肤 `88×40`，按 `badgeScale` 75%–150% 缩放），超出窗口矩形边界的位移或放大都会被硬裁切。所有动作位移与缩放必须限制在内部安全边距内。
2. **低功耗与无障碍（D-13）**：
   - 页面不可见（`document.hidden`）、系统开启 `prefers-reduced-motion: reduce` 或用户关闭总开关时，立即停止所有调度计时器与 CSS 动画（零后台消耗）。
   - 默认触发策略采用低打扰/低功耗模式，高频常驻循环需用户显式开启。
3. **最小权限（D-12）**：悬浮窗只读皮肤配置与只读加载皮肤资源，写操作（上传/切帧/删除/清理/导入导出）仅开放给主窗口（设置页）。
4. **前后端职责清晰（ADR-009）**：Rust 负责本地文件落盘、安全校验、只读协议分发与备份恢复；React 负责动画状态机、帧调度、素材预处理与设置交互。

---

## 3. 设置页交互与配置项设计

建议将原“皮肤动画”升级为所有模式共用的 **「悬浮窗动画」** 配置组（位于设置页 `#settings-appearance` 下“桌面伙伴”分组内，或在 `#settings-floating` 提供快捷跳转），按当前模式动态展示对应子项。

### 3.1 全局动画控制（所有模式通用）

| 配置项 | 控件类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| **启用悬浮窗动画** | `Switch` | `false` | 总开关，默认关闭（可手动开启）。关闭时停止一切悬浮窗动画（机器人动作、自定义帧播放、附加动效、数字跳动、面板展开动画），固定显示静态首帧/默认态。 |
| **动画触发方式** | 分段选择 | `interactive` | `interactive`（交互、完成、提醒及低频待机时播放，推荐）/ `always`（持续播放）/ `hoverOnly`（仅鼠标悬停时播放）。 |

### 3.2 悬浮机器人动作配置（`mode === "robot"` 且总开关开启）

| 配置项 | 控件类型 | 默认值 | 可选项 / 说明 |
| :--- | :--- | :--- | :--- |
| **待机动作** | 卡片/分段选择 | `blink` | `off`（关闭/静止）、`blink`（自然眨眼+天线微闪）、`float`（轻缓漂浮）、`breathe`（呼吸律动）、`lookAround`（巡航张望）、`sleep`（长时间无交互后打盹 `Zzz`） |
| **悬停打招呼** | `Switch` | `true` | 鼠标移入时抬头 + 笑眼反馈 |
| **拖拽反应** | `Switch` | `true` | 长按拎起拖动时的晃动与信号灯变化 |
| **完成庆祝** | `Switch` | `true` | 今日待办全部完成时的单次庆祝跳动 + 对勾亮起 |
| **提醒动作** | `Switch` | `true` | 到期提醒时的摇晃/脉冲提示（替代或增强纯透明度闪烁） |

### 3.3 实时交互预览舞台

在设置页中提供一个固定尺寸的 **预览舞台组件（`CompanionPreviewStage`）**：
- 直接复用悬浮窗同一渲染组件（`RobotAvatar` / `SkinSprite`）与同一动画引擎。
- 底部提供状态模拟按钮：`待机` / `悬停` / `拖拽` / `拖放` / `完成` / `提醒`，点击即可实时验证各状态动作与防裁切效果。

---

## 4. 统一帧动画引擎方案

### 4.1 状态槽位与优先级

悬浮窗同一时刻只激活优先级最高的状态槽位（`AnimationSlot`）：

```text
reminder (提醒) > grabbed (拖拽) > ready (拖放就绪) > done (今日全清) > hover (悬停) > idle (待机)
```

- **自动回退**：某槽位未配置或被用户关闭时，自动回退到 `idle`；若 `idle` 为静止/关闭，则停在首帧。
- **单次播放（`once`）**：适用于 `done` 等瞬时反馈动作；播放完末帧后停留在末帧（或按配置回落到 `idle`）。

### 4.2 内置机器人：SVG 离散帧表（Vector Frame Table）

内置机器人不生成位图，而是用声明式离散帧表驱动 `RobotAvatar` 的 SVG 部件：

```ts
export type RobotEyeState =
  | "open"
  | "half"
  | "blink"
  | "happy"
  | "lookLeft"
  | "lookRight"
  | "check"
  | "drop"
  | "sleep";

export type RobotPoseFrame = {
  /** 本帧持续时间（ms），支持非均匀节奏（如睁眼 2600ms，闭眼 120ms）。 */
  durationMs: number;
  /** 头部纵向位移（SVG 坐标单位，限制在 [-1.5, 1.5] 安全区内）。 */
  headOffsetY?: number;
  /** 头部倾角（度，限制在 [-5, 5] 安全区内）。 */
  headTiltDeg?: number;
  eyeState: RobotEyeState;
  signalBright?: boolean;
  fx?: "none" | "zzz" | "sparkle";
};
```

**优势**：
1. 任意 `badgeScale`（75%–150%）缩放均保持矢量锐利，且自动继承 3 款外形（`scout`/`relay`/`memo`）与 6 种配色。
2. 支持**非均匀帧时长**：眨眼时 95% 的时间处于单次 `setTimeout` 休眠，CPU 占用接近于 0。
3. 与自定义图片帧动画共享同一套状态优先级机与调度钩子（`useFrameTimeline`）。

### 4.3 可变时长帧调度器（`useFrameTimeline`）

- 放弃固定 `setInterval`，改用**链式 `setTimeout`** 按当前帧 `durationMs`（缺省取 `Math.round(1000 / track.fps)`）精确步进：
  - 天然支持 GIF/APNG 原始帧延迟与用户自定义单帧时长。
  - 状态切换时重置当前帧索引，确保 `done`/`hover` 总是从第 0 帧开始播放。
- **暂停条件**（任一满足即清掉定时器并停在安全帧）：
  - `!skin.animationEnabled`
  - `document.hidden === true`
  - `prefers-reduced-motion: reduce`
  - `animationTrigger === "hoverOnly" && !hovered`
  - 当前轨道 `playback === "still"` 或 `frames.length <= 1`

### 4.4 安全边距防裁切规范

- `RobotAvatar` 的 SVG `viewBox` 留出安全留白（如从 `0 0 48 36` 内部缩放内容至中心安全框，上下左右留 `3px` 缓冲），所有 `headOffsetY`、`headTiltDeg` 与 `fx` 坐标严格落在安全框内。
- `SkinSprite` 容器保留内边距（`p-1`），并将附加 CSS 动效幅度限制在 `translateY(-2px)` / `scale(1.05)` 以内，杜绝透明窗口边界硬裁切。

---

## 5. 本地文件存储架构（支持大尺寸与多帧数）

为彻底解除 `localStorage`（5 MiB）与 SQLite `settings` 值（4 MiB）的限制，自第一版起即采用 **“轻量 JSON 清单 + 本地文件资源池”** 分离架构。

### 5.1 磁盘目录布局

在 `crates/stardeskbox-common/src/paths.rs` 的 `AppPaths` 中新增 `skins/` 目录（由 `ensure_dirs()` 自动创建）：

```text
StarDeskBox/
├── database/stardeskbox.db           # settings 表中的 ui.skin 仅存轻量 JSON 清单（几 KB）
├── attachments/                # 既有：粘贴的图片附件
└── skins/
    └── assets/                 # 新增：内容寻址帧图文件（只放纯文件名，禁止子目录）
        ├── <sha256>.webp
        └── <sha256>.png
```

- **内容寻址（SHA-256）**：文件名固定为 `<64位小写hex>.<ext>`（`ext` 仅允许 `webp` | `png`）。相同图片在多状态复用或重复导入时自动去重，仅存一份。
- **原子写入**：沿用 `crates/stardeskbox-storage/src/attachment_files.rs` 的 `.part` 临时文件 + `rename` 模式，避免断电或磁盘满留下损坏图片。
- **路径安全校验**：所有读写与删除接口严格校验文件名符合 `^[0-9a-f]{64}\.(webp|png)$`，拒绝任何 `/`, `\`, `..`。

### 5.2 资源上限与规格提升

改用本地文件存储后，规格可大幅提升且不影响数据库与启动速度：

| 维度 | 旧方案（Base64 内联） | 新方案（本地文件存储） |
| :--- | :--- | :--- |
| 单帧最大边长 | `96 px` | **`256 px`**（高分屏 2x/3x + 150% 缩放依然清晰） |
| 单轨道最大帧数 | `16 帧` | **`60 帧`**（足以流畅播放 2–5 秒 12–24fps 动画） |
| 全部轨道总帧数 | `16 帧` | **`180 帧`**（6 个状态槽位自由分配，相同帧去重不重复占空间） |
| 单文件体积上限 | 受总 JSON 4MB 限制 | **`512 KB` / 帧**（WebP 编码下 256px 透明帧通常仅 5–25 KB） |
| 皮肤资源总配额 | ~3–4 MB | **`50 MB`**（可配置，远超日常动画需求） |
| `ui.skin` 清单大小 | 数百 KB ~ 数 MB | **`< 10 KB`**（仅存引用 ID、时长与配置，跨窗口同步极快） |

### 5.3 WebView 资源加载：只读自定义协议 `stardeskbox-skin://`

在 `apps/desktop/src-tauri/src/lib.rs` 中注册 Tauri v2 自定义 URI 协议 `stardeskbox-skin`（`Builder::register_uri_scheme_protocol("stardeskbox-skin", ...)`）：

- **URL 格式**：`stardeskbox-skin://localhost/<sha256>.webp`（Windows WebView2 下按 Tauri 惯例自动映射到 `http://stardeskbox-skin.localhost/<sha256>.webp`，前端提供统一 helper `skinAssetUrl(assetId, ext)` 屏蔽平台差异）。
- **安全性**：
  - 协议处理器只读 `AppPaths::skins_assets_dir()`，严格用正则校验文件名格式；非法路径直接返回 `400/404`。
  - 不开放宽泛的 `asset://` 文件系统范围权限，满足 `floating` 窗口最小权限要求。
- **性能与缓存**：
  - 响应头附带 `Content-Type: image/webp`（或 `image/png`）和 `Cache-Control: public, max-age=31536000, immutable`（因为内容寻址不可变）。
  - 帧图预加载：轨道切换或初始化时，前端用 `new Image()` 轻量预热当前活跃轨道的帧 URL，切换帧时零闪烁、零 IPC 往返。

### 5.4 新增 Rust 后端与 IPC 命令设计

遵循项目分层（`stardeskbox-common` → `stardeskbox-storage` → `stardeskbox-application` → `apps/desktop/src-tauri`）：

1. **Port 与适配器**：
   - 在 `stardeskbox-application/src/ports/files.rs` 定义 `SkinAssetStore` trait（`store_bytes` / `read_bytes` / `list_assets` / `remove_assets` / `total_bytes`）。
   - 在 `stardeskbox-storage/src/skin_files.rs` 实现 `FsSkinAssetStore`（复用原子写入与文件名校验模式）。
2. **Tauri Commands（仅主窗口 `main` 权限开放，`floating` 不可调用写命令）**：
   - `save_skin_asset(bytes: Vec<u8>, format: "webp" | "png") -> SkinAssetDto { id, ext, sizeBytes, width, height }`
     - 校验魔数（WebP/PNG header）与大小上限（≤ 512 KB），计算 SHA-256，若文件已存在则直接返回元数据（天然去重）。
   - `prune_skin_assets(keep_files: Vec<String>) -> u64`
     - 垃圾回收：删除 `skins/assets/` 中不在 `keep_files` 集合里的孤儿文件，返回释放的字节数。
   - `get_skin_storage_usage() -> SkinStorageUsageDto { fileCount, totalBytes, quotaBytes }`
     - 供设置页展示皮肤磁盘占用与一键清理。
   - `export_skin_pack(manifest_json: String, dest_path: String)` / `import_skin_pack(src_path: String) -> ImportedSkinPackDto`
     - 将清单与引用的本地帧图打包为 `.stardeskbox-skin.zip`，或从 zip 校验解压导入 `skins/assets/`。

### 5.5 备份、恢复与重置联动

在 `apps/desktop/src-tauri/src/backup.rs` 中将 `skins/assets/` 纳入与 `attachments/` 同等的生命周期管理：
- **备份（`create_backup`）**：将 `skins/assets/` 打包进备份 zip。
- **恢复（`stage_restore` / `apply_pending_restore`）**：校验文件名合法性后随数据库一并替换。
- **重置（`apply_pending_reset`）**：与 `attachments/` 一同归档到 `replaced-<时间>/`。

### 5.6 跨窗口同步与旧版数据迁移

- **跨窗口同步**：`ui.skin` 仅保留轻量 JSON（含 `assetId` 与 `ext`，不含图片二进制）。主窗口写入 `skins/assets/` 成功后更新 `ui.skin` 与 `localStorage`，悬浮窗监听 `storage` 事件收到新清单后直接通过 `stardeskbox-skin://` 加载新帧，延迟极低。
- **旧版 Base64 自动迁移**：
  - 升级后首次启动主窗口时，若检测到 `ui.skin` 中存在旧版 `frames: ["data:image/png;base64,..."]`：
    1. 将每帧解码后调用 `save_skin_asset` 落盘到 `skins/assets/`；
    2. 生成新版 `tracks.idle` 与 `assets` 元数据索引，写回 `ui.skin` 与 `localStorage`；
    3. 若迁移中单帧失败，保留原有 Base64 兜底不丢数据，下次启动重试。

---

## 6. 用户定制化工作流设计

提供 **“基础模式（低门槛）+ 高级模式（分状态精细定制）”** 两级体验：

### 6.1 多来源帧素材导入（前端预处理 → 后端落盘）

1. **多图批量导入（增强）**：
   - 支持 PNG / JPG / WebP，支持**拖拽调整帧顺序**、复制帧、删除帧、为单帧设置独立 `durationMs`。
2. **GIF / 动态 WebP 自动拆帧**：
   - 使用浏览器原生 `ImageDecoder` API（WebView2 / Chromium 原生支持）逐帧解码并保留每帧原始 `duration`（微秒转毫秒）。
   - 若原图超过 60 帧，提供等间隔自动抽帧至 60 帧并给出提示；不支持 `ImageDecoder` 的环境自动降级为取首帧。
3. **精灵图（Sprite Sheet）切帧器**：
   - 用户选择单张雪碧图后弹出轻量切帧弹窗：设置**行数 × 列数**（或单帧宽 × 高）、跳过末尾空白帧，实时叠加网格线预览与播放预览，确认后一键切分并批量落盘。
4. **编码与像素风处理**：
   - 前端缩放至 ≤ `256px`（像素风关闭 `imageSmoothingEnabled`）。
   - 优先编码为透明 WebP（像素风使用无损 PNG 保证色彩不失真，普通图使用 WebP `quality: 0.9` 兼顾清晰度与体积）。

### 6.2 基础模式 vs 高级分状态模式

- **基础模式（默认）**：用户只需编辑一套帧序列（即 `tracks.idle`），配置播放方式（循环 / 往返 / 悬停 / 静止）、FPS 与附加动效。
- **高级模式（折叠展开）**：切换状态标签页（`待机` / `悬停` / `拖拽` / `拖放` / `完成` / `提醒`），为每个状态独立配置帧序列、FPS 与播放方式；未配置的状态明确标注“沿用待机动作”。

### 6.3 皮肤包导入 / 导出（`.stardeskbox-skin.zip`）

- 导出时自动打包 `manifest.json` + 引用到的 `assets/<hash>.<ext>`，方便社区分享或跨设备迁移。
- 导入时严格校验 manifest schema、文件魔数、尺寸与总配额，防止恶意或损坏包。

---

## 7. 数据结构定义（TypeScript 清单 Schema）

`ui.skin`（SQLite）与 `stardeskbox.skin`（`localStorage`）保存的轻量清单结构：

```ts
export const SKIN_SCHEMA_VERSION = 2;

export type AnimationTrigger = "interactive" | "always" | "hoverOnly";
export type RobotIdleAction = "off" | "blink" | "float" | "breathe" | "lookAround" | "sleep";
export type AnimationSlot = "idle" | "hover" | "grabbed" | "ready" | "done" | "reminder";
export type TrackPlayback = "loop" | "pingpong" | "once" | "still";

/** 已落盘的本地帧资源元数据（不含图片二进制）。 */
export type SkinAssetMeta = {
  /** SHA-256 64 位十六进制哈希。 */
  id: string;
  ext: "webp" | "png";
  width: number;
  height: number;
  sizeBytes: number;
};

/** 轨道中的单帧引用。 */
export type FrameRef = {
  assetId: string;
  /** 可选单帧停留时长（ms）；未设置时按轨道 fps 计算。 */
  durationMs?: number;
};

/** 单个状态槽位的动画轨道。 */
export type AnimationTrack = {
  frames: FrameRef[];
  fps: number;              // 1..30
  playback: TrackPlayback;
};

export type RobotActionConfig = {
  idle: RobotIdleAction;
  hover: boolean;
  grabbed: boolean;
  ready: boolean;
  done: boolean;
  reminder: boolean;
};

export type Skin = {
  version: 2;
  // === 外观基础字段（沿用现有） ===
  mode: "robot" | "image" | "badge";
  robot: "scout" | "relay" | "memo";
  color: "original" | "steel" | "mint" | "amber" | "lilac" | "pearl";
  face: "friendly" | "focused" | "playful";
  pixel: boolean;
  showCount: boolean;
  motion: "none" | "float" | "breathe" | "bounce";

  // === 全局动画总控 ===
  animationEnabled: boolean;
  animationTrigger: AnimationTrigger;

  // === 内置机器人动作配置 ===
  robotAction: RobotActionConfig;

  // === 本地文件帧动画清单 ===
  assets: Record<string, SkinAssetMeta>;
  tracks: Partial<Record<AnimationSlot, AnimationTrack>>;
};
```

---

## 8. 涉及模块与实施分期建议

### 8.1 关键改动文件清单

| 层级 | 文件 | 职责 |
| :--- | :--- | :--- |
| Rust Common | `crates/stardeskbox-common/src/paths.rs` | `AppPaths` 新增 `skins_dir()` / `skins_assets_dir()` |
| Rust Application | `crates/stardeskbox-application/src/ports/files.rs` | 新增 `SkinAssetStore` trait |
| Rust Storage | `crates/stardeskbox-storage/src/skin_files.rs`（新增） | 内容寻址落盘、魔数/配额校验、原子写入、孤儿 GC |
| Tauri Host | `apps/desktop/src-tauri/src/lib.rs` | 注册 `stardeskbox-skin://` 只读自定义协议 |
| Tauri Host | `apps/desktop/src-tauri/src/commands/skin.rs`（新增） | `save_skin_asset` / `prune_skin_assets` / `get_skin_storage_usage` / 导入导出 |
| Tauri Host | `apps/desktop/src-tauri/src/backup.rs` | 备份/恢复/重置纳入 `skins/assets/` |
| Tauri Capabilities | `apps/desktop/src-tauri/capabilities/main.json` | 仅向主窗口开放皮肤文件写命令 |
| UI Store | `apps/desktop/ui/src/stores/skin-store.ts` | Schema v2、`sanitizeSkin`、旧版 Base64 自动迁移、GC 触发 |
| UI Floating | `apps/desktop/ui/src/features/floating/model/frame-timeline.ts`（新增） | 统一状态优先级与可变时长帧调度器 |
| UI Floating | `apps/desktop/ui/src/features/floating/model/robot-actions.ts`（新增） | 机器人 5 种待机 + 5 种交互离散帧表 |
| UI Floating | `apps/desktop/ui/src/features/floating/RobotAvatar.tsx` | 接入 `RobotPoseFrame` 渲染与安全边距 |
| UI Floating | `apps/desktop/ui/src/features/floating/SkinSprite.tsx` | 接入 `stardeskbox-skin://` URL、预加载与多状态轨道 |
| UI Settings | `apps/desktop/ui/src/features/settings/SettingsPage.tsx` | 全局动画开关、机器人动作配置与预览舞台 |
| UI Settings | `apps/desktop/ui/src/features/settings/SkinSetting.tsx` | GIF 拆帧、雪碧图切帧、帧排序/时长、多状态轨道、存储占用与导入导出 |
| UI i18n & CSS | `apps/desktop/ui/src/i18n/{zh-CN,en}.json`, `styles/global.css` | 文案、安全动效关键帧、关闭动画全局覆写 |

### 8.2 推荐分期落地

1. **阶段 1：本地文件存储底座 + 全局开关 + 机器人动作**
   - 落地 `skins/assets/`、`FsSkinAssetStore`、`stardeskbox-skin://` 协议、备份恢复联动与旧版 Base64 迁移。
   - 落地统一帧调度器（`useFrameTimeline`）、动画总开关、触发策略、内置机器人全套动作（含关闭）与设置页实时预览舞台。
2. **阶段 2：自定义帧动画增强**
   - 升级帧规格至 256px / 60 帧，接入 GIF/WebP `ImageDecoder` 自动拆帧、精灵图网格切帧、帧拖拽排序与单帧时长编辑。
3. **阶段 3：多状态分轨与皮肤包分享**
   - 开放高级模式（按 `idle/hover/grabbed/ready/done/reminder` 分轨配置）、磁盘占用展示与 `.stardeskbox-skin.zip` 导入/导出。

---

## 9. 测试与验收要点

- **Rust 单元测试**：内容寻址去重、路径遍历注入拒绝（`../`、反斜杠、非 hex 扩展名）、超限拦截（>512KB / >50MB）、孤儿 GC 准确性、备份与恢复后 `skins/assets/` 完整一致。
- **前端单元测试**：`sanitizeSkin` 对旧版 v1 数据迁移、状态优先级切换（`reminder > grabbed > ... > idle`）、可变时长帧调度、隐藏页面与 `prefers-reduced-motion` 自动暂停、关闭总开关后零定时器。
- **视觉与交互验收**：`badgeScale` 75%–150% 下所有机器人动作与皮肤动效无矩形裁切；深/浅主题与 3 款机器人各配色表现正常；主窗口修改配置后悬浮窗即时同步生效。
