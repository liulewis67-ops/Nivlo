# Nivlo · 拾序 前端开发规范（Frontend Development Guide）

> Status: v1.0  
> Last Updated: 2026-10-09  
> 适用范围：`apps/desktop/ui/` 下的全部代码（React + TypeScript，运行于 Tauri 2 WebView）  
> 依据文档：[技术架构](../architecture/Nivlo_Technical_Architecture.md)、[实施计划](../architecture/Nivlo_Implementation_Plan.md)、[后端开发规范](Nivlo_Backend_Development_Guide.md)  
> 规范中的「必须 / 禁止」为强制要求，CI 与 Code Review 按此执行；「建议」为推荐做法，偏离时需在 PR 中说明理由。

---

# 1. 前端职责边界

架构原则：**React 只负责 UI，不承担核心业务**（架构文档 §3.2、§68）。

| 前端负责 | 前端不负责（属于 Rust 后端） |
|---|---|
| 视图渲染、交互、动画 | 业务规则（Todo 能否完成、Tip 规则、Today 规则等） |
| UI 本地状态（hover、弹窗、拖拽中、选中日期） | 数据持久化、事务 |
| 通过 Typed IPC 调用 Use Case | SQL、文件读写、网络请求 |
| 查询缓存与 Optimistic Update | Workflow 匹配与执行、脚本执行 |
| 订阅后端事件并更新缓存 | 调度、提醒、通知触发 |
| 窗口内的布局与展开动画 | 窗口位置、尺寸、置顶、焦点、吸附（由 Rust 通过 `FloatingWindowPort` 实现） |

**禁止**：

- 在前端实现或复制业务规则（例如自己判断「哪些 Item 属于 Today」）。前端只展示后端返回的结果。
- 在前端发起任何 HTTP 请求（`fetch`、`axios` 等）。所有网络访问由后端 `HttpPort` 完成。
- 把 React State / Zustand / localStorage 当作业务数据的存储。SQLite 是唯一 Source of Truth。
- 直接使用 `@tauri-apps/api/core` 的 `invoke` 调用命令，必须通过生成的 Binding（见 §6）。

---

# 2. 技术栈要求

## 2.1 运行环境与工具

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **24.x LTS**（通过 `.nvmrc` 与 `package.json#engines` 锁定） | 所有开发者与 CI 使用同一主版本 |
| 包管理器 | **pnpm 10.x**（通过根 `package.json#packageManager` 锁定，Corepack 启用） | **唯一允许的包管理器**，见 §3 |
| WebView（Windows） | Microsoft Edge WebView2 Runtime（Evergreen） | 开发机与目标机都需安装 |
| 编辑器 | 建议 VS Code + ESLint、Prettier、Tailwind CSS IntelliSense、rust-analyzer 插件 | 仓库提供 `.vscode/extensions.json` |

## 2.2 依赖技术栈

> 下表为基线主版本。确切版本在实施计划 0.1 初始化时锁定于 `pnpm-lock.yaml`；升级主版本需单独 PR 并在 PR 中说明影响。

| 分类 | 技术 | 基线版本 | 用途 / 约束 |
|---|---|---|---|
| 语言 | TypeScript | ≥ 5.6 | `strict: true`，见 §12 |
| UI 框架 | React | 19.x | 只用函数组件 + Hooks |
| 构建 | Vite | ≥ 6 | Tauri 前端构建工具 |
| 桌面桥接 | `@tauri-apps/api`、`@tauri-apps/cli` | 2.x | `@tauri-apps/cli` 作为 devDependency，通过 `pnpm tauri ...` 调用 |
| Tauri 插件 JS 端 | `@tauri-apps/plugin-*` | 2.x | 只引入后端已启用且 Capability 允许的插件 |
| 样式 | Tailwind CSS | 4.x | 结合 Design Token（CSS 变量），见 §8 |
| UI 状态 | Zustand | 5.x | 只存 UI 本地状态，见 §7 |
| 查询缓存 | TanStack Query | 5.x | 封装 IPC 查询、Optimistic Update |
| 拖拽排序 | dnd-kit（`@dnd-kit/core`、`@dnd-kit/sortable`） | 最新稳定版 | Today Stack、Calendar 内部拖拽 |
| 日期 | date-fns | 4.x | 禁止 moment.js / dayjs |
| 代码编辑器 | CodeMirror | 6.x | Phase 8 Script 编辑器、Markdown 编辑 |
| 国际化 | i18next + react-i18next | 最新稳定版 | 见 §11 |
| 无样式交互原语 | Radix UI Primitives（可选） | 最新稳定版 | 仅限 headless 组件（Popover、Menu、Dialog 等），用于可访问性 |
| 测试 | Vitest + React Testing Library + `@testing-library/user-event` | Vitest ≥ 3 | 见 §14 |
| 代码质量 | ESLint（flat config）、Prettier、`typescript-eslint`、`eslint-plugin-react-hooks`、`eslint-plugin-jsdoc` | 最新稳定版 | 见 §13 |

## 2.3 禁止引入的依赖

| 禁止 | 原因 / 替代 |
|---|---|
| Redux、MobX、Recoil、Jotai | 统一使用 Zustand + TanStack Query |
| axios、ky 等 HTTP 客户端 | 前端不发网络请求 |
| moment、dayjs | 统一使用 date-fns |
| MUI、Ant Design、Chakra 等带完整样式的组件库 | 与 Design Token 冲突、跨 WebView 外观不可控；只允许 headless 原语 |
| lodash 全量包 | 优先使用原生 API；确有需要时按函数单独引入并在 PR 中说明 |
| styled-components、emotion 等 CSS-in-JS | 统一使用 Tailwind + CSS 变量 |
| 任何依赖实验性 Web API 的库 | 架构文档 §47：WebView 跨平台差异 |

新增任何**运行时依赖**都必须在 PR 描述中说明：用途、包体积影响、维护状态、为什么现有依赖无法满足。

---

# 3. pnpm 使用规范

## 3.1 基本要求

- **必须**只使用 pnpm。根 `package.json` 中声明：

  ```json
  {
    "packageManager": "pnpm@10.x.x",
    "engines": { "node": ">=24 <25", "pnpm": ">=10 <11" },
    "scripts": { "preinstall": "npx only-allow pnpm" }
  }
  ```

  （`packageManager` 中写入确切版本号。）
- 首次环境准备：

  ```bash
  corepack enable
  ```

  ```bash
  pnpm install
  ```

- **禁止**提交 `package-lock.json`、`yarn.lock`；`pnpm-lock.yaml` **必须**提交。
- CI 中**必须**使用 `pnpm install --frozen-lockfile`。
- 依赖版本由 lockfile 锁定；`package.json` 中使用 `^` 范围即可，但主版本升级需单独 PR。

## 3.2 Workspace

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/desktop/ui"
```

- 前端包名：`@nivlo/desktop-ui`。
- 在仓库根目录对子包执行命令使用 `pnpm -C apps/desktop/ui <script>` 或 `pnpm --filter @nivlo/desktop-ui <script>`。
- 根 `package.json` 提供聚合脚本，开发者通常只需在根目录执行。

## 3.3 标准脚本

| 命令（在仓库根目录执行） | 作用 |
|---|---|
| `pnpm tauri dev` | 启动桌面应用（Vite Dev Server + Rust） |
| `pnpm tauri build` | 构建安装包 |
| `pnpm dev:ui` | 只启动 Vite（纯 UI 调试，IPC 使用 Mock，见 §6.5） |
| `pnpm lint` | ESLint（含注释规范检查） |
| `pnpm format` / `pnpm format:check` | Prettier 格式化 / 检查 |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest 单次运行 |
| `pnpm test:watch` | Vitest 监听模式 |
| `pnpm gen:bindings` | 从 Rust 生成 TS Binding 到 `src/bindings/` |

## 3.4 依赖操作

- 添加依赖：`pnpm --filter @nivlo/desktop-ui add <pkg>`（开发依赖加 `-D`）。
- 禁止全局安装项目所需的工具；所有工具作为 devDependency 并通过 `pnpm exec` / 脚本调用。
- 定期执行 `pnpm audit`；高危漏洞须在一周内处理。

---

# 4. 目录结构

```text
apps/desktop/ui/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── eslint.config.js
└── src/
    ├── main.tsx                # 入口：根据窗口 label 挂载对应 App
    ├── app/
    │   ├── floating/           # 悬浮窗 App 根组件与布局
    │   ├── main/               # 主窗口 App 根组件、导航、路由
    │   └── providers/          # QueryClient、i18n、Theme 等全局 Provider
    ├── features/               # 按业务功能划分（见 4.1）
    │   ├── today/
    │   ├── inbox/
    │   ├── capture/
    │   ├── calendar/
    │   ├── notes/
    │   ├── projects/
    │   ├── search/
    │   ├── workflow/
    │   └── settings/
    ├── components/             # 与业务无关的通用组件（Button、Input、Menu、Toast…）
    ├── bindings/               # 自动生成的 IPC Binding —— 禁止手改
    ├── stores/                 # 跨 feature 共享的 Zustand Store（尽量少）
    ├── hooks/                  # 跨 feature 共享的 Hook
    ├── lib/                    # 基础工具：ipc、query-keys、date、errors、logger
    ├── i18n/                   # 语言资源：zh-CN.json、en.json
    ├── styles/                 # tokens.css、global.css
    └── test/                   # 测试工具、IPC Mock、fixtures
```

## 4.1 Feature 内部结构

```text
features/today/
├── index.ts                 # 对外唯一出口（只导出其他 feature 需要的内容）
├── api.ts                   # 该 feature 的 Query / Mutation Hook（封装 IPC）
├── components/              # 该 feature 私有组件
├── hooks/                   # 该 feature 私有 Hook
├── store.ts                 # 该 feature 私有 UI 状态（可选）
├── model/                   # 纯 TS 逻辑（状态机、计算函数），不依赖 React
└── __tests__/
```

## 4.2 依赖规则

- `features/A` **禁止**直接引用 `features/B` 的内部文件，只能通过 `features/B/index.ts`。
- `components/` **禁止**引用 `features/`。
- `lib/` **禁止**引用 `features/`、`components/`。
- 只有 `lib/ipc` 可以引用 `bindings/`。
- 以上规则通过 ESLint `import/no-restricted-paths`（或等价规则）强制。

---

# 5. 窗口入口

应用只有两个长期窗口：`floating` 与 `main`（架构文档 §10）。

- `main.tsx` 读取当前窗口 label，挂载 `app/floating` 或 `app/main`；两者共享 Provider，但**不共享路由**。
- 悬浮窗包体应尽量小：`app/floating` 只引入 Today、Quick Create、Capture 相关 feature，Calendar、Workflow 编辑器等通过动态 `import()` 只在主窗口加载。
- 悬浮窗只能调用 `capabilities/floating.json` 允许的命令；在悬浮窗代码中调用主窗口专属命令属于缺陷（运行时会被 Tauri 拒绝）。

---

# 6. IPC 规范

## 6.1 Binding

- Rust DTO 是唯一来源。`src/bindings/` 由 `pnpm gen:bindings` 生成，**禁止手改**，文件头带「自动生成」声明。
- CI 会检查生成结果与提交内容一致；修改 Rust Command / DTO 后必须重新生成并提交。

## 6.2 调用封装

- 所有调用经过 `lib/ipc`：统一处理错误转换、开发模式日志、耗时统计。
- Feature 内通过 `api.ts` 暴露 Query / Mutation Hook，组件**禁止**直接调用 `lib/ipc`。

```ts
// features/today/api.ts

/**
 * 查询今天的 Today 列表（已按 Today Order 排序）。
 *
 * 数据只在首次挂载时向后端请求一次，之后由 `useTodayEventSync`
 * 根据后端事件增量更新缓存；Hover 展开时不会触发请求。
 *
 * @returns TanStack Query 结果，`data` 为后端返回的 `TodayView`。
 */
export function useTodayQuery() {
  return useQuery({
    queryKey: queryKeys.today(),
    queryFn: () => ipc.getToday(),
    staleTime: Infinity, // 由事件驱动刷新，不依赖过期重取
  });
}
```

## 6.3 错误处理

- 后端错误统一为 `{ code, message, action }`（后端规范 §7）。`lib/errors` 将其转换为 `AppError` 类。
- UI 根据 `code` 决定展示方式，根据 `action` 渲染操作按钮（如 `OPEN_INTEGRATION_SETTINGS` → 「连接 Jira」）。
- **禁止**向用户展示原始错误堆栈或英文后端 `message`；用户可见文案来自 i18n（以 `code` 为 key），`message` 只用于日志。

## 6.4 事件

- 后端事件（`item_created`、`item_updated`、`today_reordered`、`day_changed` 等）在 `app/providers` 层统一订阅，转为 `queryClient.setQueryData` / `invalidateQueries`。
- 每个 `listen` 必须在组件卸载 / 窗口销毁时取消订阅。
- **禁止**在事件回调中执行耗时计算或连续发起多次 IPC。

## 6.5 IPC Mock

- `src/test/ipc-mock.ts` 提供与 Binding 同签名的内存实现，用于 Vitest 与 `pnpm dev:ui`。
- Mock 的数据形状必须使用生成的类型，禁止 `as any`。

---

# 7. 状态管理

## 7.1 分工

| 状态类型 | 工具 | 示例 |
|---|---|---|
| 领域数据（来自后端） | TanStack Query | Today、Inbox、Calendar、Item 详情、Workflow 列表、搜索结果 |
| UI 本地状态 | Zustand / 组件 `useState` | hover、悬浮窗状态机、弹窗、选中日期、Calendar 视图、拖拽中 |
| 用户偏好（UI 层面、无需同步） | Zustand + `localStorage`（可选） | 侧栏折叠 |
| 业务设置 | 后端 `settings`（经 IPC） | 快捷键、置顶、语言、主题、开机自启 |

**禁止**把领域数据复制进 Zustand。

## 7.2 Query Key

- 所有 Query Key 由 `lib/query-keys.ts` 的工厂函数生成，**禁止**在业务代码中手写数组字面量 Key。

```ts
export const queryKeys = {
  today: () => ['today'] as const,
  inbox: () => ['inbox'] as const,
  item: (id: ItemId) => ['item', id] as const,
  calendar: (range: DateRange) => ['calendar', range.start, range.end] as const,
};
```

## 7.3 Optimistic Update

所有用户高频操作（完成、排序、推迟、拖拽排期）**必须**使用 Optimistic Update，流程遵循架构文档 §15：

```text
立即更新缓存 → 调用 IPC → 成功：保留（以后端返回为准） → 失败：回滚 + Toast
```

实现要求：

- `onMutate` 中先 `cancelQueries`，再保存快照、写入乐观值。
- `onError` 中用快照回滚，并通过 Toast 显示 i18n 错误文案。
- `onSettled` 中以后端事件或返回值校正，不盲目 `invalidateQueries` 全量重取。
- 可撤销的操作（完成、推迟、删除、捕获）显示 Undo Toast，Undo 通过后端命令实现，而不是只恢复前端缓存。

## 7.4 Zustand 规范

- 每个 Store 一个文件，按 feature 放置；Store 只保存可序列化数据。
- 组件中使用 selector 订阅最小必要字段，避免整个 Store 变化导致重渲染：`useFloatingStore((s) => s.state)`。
- Action 定义在 Store 内，命名为动词（`expand`、`collapse`、`startQuickCreate`）。

---

# 8. 样式与 Design System

## 8.1 Design Token

- 所有颜色、间距、圆角、字体、阴影、z-index、动画时长定义在 `styles/tokens.css`（CSS 变量），Tailwind 主题引用这些变量。
- **禁止**在组件中硬编码颜色值（`#xxxxxx`、`rgb()`）、魔法数字 z-index、魔法数字动画时长。
- 主题：浅色 / 深色通过根元素 `data-theme` 切换，所有 Token 必须有两套取值。

## 8.2 跨 WebView 一致性（架构文档 §47）

- **必须**使用 `components/` 中的自定义控件（Button、Input、Checkbox、Select、Scrollbar 等），禁止依赖浏览器默认控件外观。
- 字体栈在 Token 中明确声明（中文优先 `"Microsoft YaHei UI"`、`"PingFang SC"`，再到系统 UI 字体）。
- 禁止使用实验性 CSS / Web API；使用新特性前确认 WebView2、WKWebView、WebKitGTK 均支持。

## 8.3 动画

- 只使用 `transform` 与 `opacity` 做动画；动画时长使用 Token（如 `--duration-fast`）。
- **禁止**持续运行的 `requestAnimationFrame` 循环与无限 CSS 动画（加载指示器除外，且不可见时必须停止）。
- 尊重 `prefers-reduced-motion`。

---

# 9. 悬浮窗专项规范

悬浮窗是常驻组件，性能要求高于其他界面（架构文档 §12、§46）。

1. **Hover 不得触发 IPC、数据库查询或网络请求**，只使用已缓存的 Today 数据渲染。
2. 悬浮窗状态机（`Collapsed / Expanded / QuickCreate / DragHover`）**必须**实现为 `features/floating/model/` 下的纯 TS 模块，与 React 解耦并有完整单元测试。
3. 窗口尺寸、位置、焦点由 Rust 控制；前端只通过命令请求（如 `expand(bounds)`），**禁止**在前端用 `window` API 自行移动 / 缩放窗口。
4. 悬浮窗中所有 Timer（Hover 延迟、离开延迟、Toast）必须在状态切换和卸载时清除。
5. 悬浮窗渲染的组件数量与 DOM 节点保持最少；Today 列表超过 50 项时使用虚拟列表。
6. 新增悬浮窗功能前，确认对应命令已在 `floating` Capability 白名单中（实施计划 D-12）。

---

# 10. 拖拽

| 场景 | 方案 |
|---|---|
| 应用内拖拽（Today 排序、拖到 Tomorrow、Calendar 排期） | dnd-kit（基于 Pointer 事件），必须开启键盘传感器以支持键盘操作 |
| 外部拖入（浏览器 URL、文件、文本） | 由后端 `DropPort` 与 Tauri 拖放事件处理；前端只负责 DragHover 视觉状态和结果反馈。具体方案以实施计划 D-10 定稿为准 |

- 拖拽结束后**立即**调用对应命令持久化，并使用 Optimistic Update。
- 拖拽中的坐标计算、碰撞检测等逻辑属于「复杂逻辑」，必须写行内注释（见 §15.4）。

---

# 11. 国际化

- 默认语言 `zh-CN`，第二语言 `en`（实施计划 D-06）。
- **所有用户可见文本**（包括按钮、提示、空状态、错误、`aria-label`）必须来自 `src/i18n/*.json`，禁止在 JSX 中硬编码文本。
- Key 命名：`<feature>.<场景>.<元素>`，例如 `today.empty.title`、`error.ITEM_NOT_FOUND`。
- 日期格式化使用 date-fns 的 locale，不手拼日期字符串。

---

# 12. TypeScript 规范

- `tsconfig`：`strict: true`、`noUncheckedIndexedAccess: true`、`noImplicitOverride: true`、`exactOptionalPropertyTypes: true`。
- **禁止** `any`。确需绕过类型时使用 `unknown` + 类型守卫；无法避免的 `any` 必须带 `// eslint-disable-next-line` 并在同一行注释说明原因。
- **禁止**无理由的非空断言 `!`；**禁止** `@ts-ignore`（必要时使用 `@ts-expect-error` 并注明原因）。
- 用字符串字面量联合类型替代 `enum`；`switch` 必须穷尽（`default` 中使用 `assertNever`）。
- 领域 ID 使用 Binding 中的品牌类型（如 `ItemId`），不与普通 `string` 混用。
- 组件 Props 使用 `type` 定义并命名为 `XxxProps`。

## 12.1 命名约定

| 对象 | 规则 | 示例 |
|---|---|---|
| 组件、组件文件 | PascalCase | `TodayList.tsx` |
| Hook | `use` + camelCase | `useTodayQuery` |
| 普通函数、变量 | camelCase | `computeExpandBounds` |
| 常量 | UPPER_SNAKE_CASE | `HOVER_ENTER_DELAY_MS` |
| 类型 / 接口 | PascalCase | `FloatingState` |
| 非组件文件 | kebab-case | `query-keys.ts` |
| 测试文件 | `*.test.ts(x)` | `floating-machine.test.ts` |
| 布尔值 | `is / has / can / should` 前缀 | `isExpanded` |
| 事件处理 Props / 函数 | `onXxx` / `handleXxx` | `onComplete` / `handleDrop` |

时间相关常量必须带单位后缀：`_MS`、`_PX`。

---

# 13. Lint 与格式化

- ESLint（flat config）：`typescript-eslint`（strict + type-checked）、`eslint-plugin-react-hooks`、`eslint-plugin-jsdoc`、import 路径限制规则。
- Prettier 负责格式；ESLint 不做格式检查。
- 注释规范通过 `eslint-plugin-jsdoc` 强制（见 §15.6）。
- CI 中 `pnpm lint`、`pnpm typecheck`、`pnpm format:check` 任一失败即阻止合并。
- **禁止**以整文件 `/* eslint-disable */` 方式关闭规则。

---

# 14. 测试

| 类型 | 工具 | 必须覆盖 |
|---|---|---|
| 纯逻辑单元测试 | Vitest | `model/` 下所有模块：悬浮窗状态机、展开方向计算、日期工具、排序计算 |
| 组件测试 | Vitest + React Testing Library + user-event | 关键交互：Quick Create、完成 / Undo、Optimistic 失败回滚、Inbox 操作 |
| IPC 行为 | IPC Mock | 断言调用的命令与参数；断言 Hover 时**未**调用 IPC |
| E2E | tauri-driver（实施计划 7.1） | 只覆盖关键路径 |

要求：

- 使用 `vi.useFakeTimers()` 测试所有与延迟相关的逻辑（Hover 延迟、Undo 倒计时）。
- 查询元素优先使用 `getByRole` / `getByLabelText`，避免依赖 CSS 类名或 `data-testid`（确实无法通过语义查询时才使用 `data-testid`）。
- `model/` 目录测试覆盖率目标 ≥ 90%；整体不设硬性覆盖率，但新增交互必须有测试。
- 测试名称描述行为：`it('hover 展开期间不发起 IPC 调用')`。

---

# 15. 注释规范（强制）

注释的目的：让后续开发者（包括 Code Agent）**不读实现就能正确使用一个函数**，并且**读到复杂代码时能理解为什么这样写**。

## 15.1 注释语言

- 注释统一使用**简体中文**；类型名、API 名、专有名词（Today Stack、Capture、Workflow 等）保留英文原文。
- 标识符（变量、函数、类型名）一律使用英文。

## 15.2 函数注释（必须）

以下每一项**都必须**有 TSDoc（`/** ... */`）注释：

- 所有具名函数（`function` 声明、赋值给常量的箭头函数），**无论是否导出**。
- 所有 React 组件。
- 所有自定义 Hook。
- Zustand Store 的每个 Action。
- 所有导出的类型、接口及其非显而易见的字段。
- 所有导出的常量（说明含义与取值依据）。

豁免：JSX 中的内联匿名回调（如 `onClick={() => setOpen(true)}`）、测试用例函数体。

函数注释内容要求：

| 部分 | 要求 |
|---|---|
| 摘要（第一行） | 一句话说明「做什么」，以动词开头 |
| 详细说明（可选，复杂函数必须） | 说明行为细节、前置条件、副作用（是否调用 IPC、是否修改缓存、是否启动 Timer）、与其他模块的关系 |
| `@param` | 每个参数都要写；说明含义、单位、取值范围；对象参数说明关键字段 |
| `@returns` | 有返回值时必须写；说明返回内容及特殊值（如 `null` 表示什么） |
| `@throws` | 可能抛出时必须写，说明抛出的错误类型与条件 |
| `@example` | 公共工具函数（`lib/`、`components/`）建议提供 |
| `@see` | 涉及架构 / 产品文档的设计时，引用对应章节（如 `@see 架构文档 §12`） |

组件注释说明：组件用途、使用位置、关键 Props 的行为；Props 类型的每个字段使用 `/** */` 单独注释。

### 示例：普通函数

```ts
/**
 * 根据悬浮窗所在的吸附边缘，计算 Today 面板的展开区域。
 *
 * 面板总是朝屏幕内侧展开，并会被约束在当前显示器工作区内，
 * 保证在任意边缘或角落吸附时面板都完整可见。
 * 纯函数，不调用 IPC，不读取 DOM。
 *
 * @param anchor 收起态徽标的当前区域（logical px）。
 * @param edge 当前吸附边缘；`null` 表示未吸附，此时默认向左下展开。
 * @param panelSize 面板期望尺寸（logical px）。
 * @param workArea 当前显示器工作区（logical px，已排除任务栏）。
 * @returns 面板应占据的区域（logical px），可直接传给 `expandFloating` 命令。
 * @see 架构文档 §10.1、实施计划 1.3
 */
export function computeExpandBounds(
  anchor: Rect,
  edge: SnapEdge | null,
  panelSize: Size,
  workArea: Rect,
): Rect {
  // ...
}
```

### 示例：组件

```tsx
/** `TodayList` 的属性。 */
type TodayListProps = {
  /** 已按 Today Order 排好序的 Todo；组件不会再次排序。 */
  items: readonly TodayItem[];
  /** 是否显示拖拽手柄；悬浮窗收起动画进行中时应为 `false`。 */
  isSortable: boolean;
};

/**
 * Today Stack 列表，支持拖拽排序与勾选完成。
 *
 * 同时用于悬浮窗与主窗口 Today 视图。排序与完成都使用 Optimistic Update，
 * 失败时自动回滚并提示。
 */
export function TodayList({ items, isSortable }: TodayListProps) {
  // ...
}
```

### 示例：Store Action

```ts
export const useFloatingStore = create<FloatingStore>()((set, get) => ({
  state: 'collapsed',

  /**
   * 处理鼠标进入悬浮窗。
   *
   * 不会立即展开：启动 `HOVER_ENTER_DELAY_MS` 延迟计时，
   * 期间如果鼠标离开则取消，避免鼠标掠过时误展开。
   */
  pointerEnter: () => {
    // ...
  },
}));
```

## 15.3 文件 / 模块注释

`model/`、`lib/` 下的每个文件以及每个 feature 的 `index.ts` 顶部必须有模块注释，说明：模块职责、主要导出、与其他模块的关系。

```ts
/**
 * @module floating-machine
 *
 * 悬浮窗状态机：Collapsed / Expanded / QuickCreate / DragHover。
 *
 * 纯 TS 实现，不依赖 React 与 Tauri，便于用 fake timers 测试。
 * React 层通过 `useFloatingMachine` 订阅状态并把窗口尺寸请求转发给 Rust。
 *
 * @see 架构文档 §10.1
 */
```

## 15.4 行内注释（复杂逻辑必须）

以下情况**必须**写行内注释（`//`），且注释说明的是**为什么**，而不是复述代码做了什么：

1. **状态机与时序**：状态转移的触发条件、Timer 的启动与清除时机、竞态处理。
2. **Optimistic Update**：快照保存、回滚、与后端事件合并的规则。
3. **坐标与尺寸计算**：DPI / logical px 换算、边缘吸附、展开方向、拖拽碰撞判断。
4. **非直观的业务约束**：例如「Today Order 与 priority 无关」「Tip 没有完成状态」。
5. **性能相关写法**：`useMemo` / `useCallback` / `memo` 的使用理由、为什么不在此处查询数据。
6. **平台 / WebView 兼容性处理（Workaround）**：必须写明问题现象、影响的平台、相关 Issue 链接，以及何时可以移除。
7. **正则表达式**：说明匹配目标，并给出一个匹配示例与一个不匹配示例。
8. **魔法数字**：无法提取为命名常量时，说明取值依据。
9. **故意偏离常规写法的代码**：例如故意不清理某个状态、故意吞掉错误。

### 示例

```ts
function handlePointerLeave() {
  // 不立即收起：鼠标从徽标斜向移动到面板的过程中会短暂离开窗口命中区域，
  // 立即收起会造成闪烁。延迟期间如果重新进入（含 Safe Area），则取消收起。
  leaveTimer = setTimeout(collapse, HOVER_LEAVE_DELAY_MS);
}

onMutate: async ({ itemId }) => {
  // 先取消进行中的 Today 查询，避免旧的响应在乐观更新之后到达并覆盖它。
  await queryClient.cancelQueries({ queryKey: queryKeys.today() });
  const snapshot = queryClient.getQueryData(queryKeys.today());
  // ...
  return { snapshot }; // 供 onError 回滚使用
},

// WORKAROUND(WebView2): 拖拽文件进入窗口时，WebView2 不会触发 dragleave，
// 导致 DragHover 状态残留。这里改用 Tauri 的 drag-leave 事件作为补充。
// 参见 <Issue 链接>；WebView2 修复后可删除。
```

## 15.5 特殊标记

| 标记 | 格式 | 要求 |
|---|---|---|
| 待办 | `// TODO(P2.4): 说明` | 必须关联实施计划子阶段编号或 Issue；禁止无归属的 TODO |
| 已知问题 | `// FIXME(P2.4): 说明` | 同上，合入主分支前尽量消除 |
| 兼容处理 | `// WORKAROUND(<平台或组件>): 说明` | 见 15.4 第 6 条 |
| 安全相关 | `// SECURITY: 说明` | 涉及权限、外部输入展示、XSS 风险时使用 |

## 15.6 禁止事项与自动检查

**禁止**：

- 提交被注释掉的代码（应删除，历史由 git 保存）。
- 与代码不一致的过期注释——修改代码时必须同步修改注释，Code Review 中视为缺陷。
- 复述代码的无效注释（如 `// i 加 1`）。
- 在注释中写入 Token、真实用户数据、内部链接中的敏感参数。

**自动检查**（`eslint-plugin-jsdoc`）：

- `jsdoc/require-jsdoc`：对 `FunctionDeclaration`、顶层 `VariableDeclarator > ArrowFunctionExpression`、`MethodDefinition`、`TSTypeAliasDeclaration`（导出）开启，`publicOnly: false`。
- `jsdoc/require-param`、`jsdoc/require-returns`、`jsdoc/check-param-names`：开启。
- `jsdoc/require-description`：开启。
- TypeScript 已有类型，因此关闭 `jsdoc/require-param-type`、`jsdoc/require-returns-type`。
- 行内注释的必要性无法自动检查，由 Code Review 按 §15.4 判定。

---

# 16. 可访问性与体验

- 所有交互元素可通过键盘到达与操作，焦点可见。
- 图标按钮必须有 `aria-label`（来自 i18n）。
- 文本与背景对比度满足 WCAG AA。
- 操作反馈：用户操作在 100ms 内必须有视觉反馈（Optimistic Update 或加载状态）。
- 「先做，再 Undo」（产品文档 §27.1）：除彻底删除外，不弹确认对话框，改为可撤销 Toast。

---

# 17. 性能规范

- 悬浮窗：Hover 展开只做 CSS / React 状态变化（§9）。
- 列表超过 50 项使用虚拟列表；Calendar 单元格组件必须 `memo` 化。
- 不在渲染函数中创建大对象或执行 O(n²) 计算；派生数据用 `useMemo` 并注释理由。
- 主窗口隐藏时暂停非必要的渲染与动画。
- 包体积：悬浮窗入口 chunk（gzip 后）目标 ≤ 150KB；超出时需在 PR 中说明。
- 禁止高频轮询（`setInterval` 拉取数据）；数据更新依赖后端事件。

---

# 18. 安全

- **禁止** `dangerouslySetInnerHTML`。确需渲染 Markdown / HTML 时，必须经过白名单 Sanitizer，并以 `// SECURITY:` 注释说明。
- 外部 URL 只能通过后端 `open_url` 类命令打开，不在 WebView 内导航到外部页面。
- 不在 `localStorage` 中保存任何凭据或业务数据。
- 前端日志不得输出 Item 内容全文、剪贴板内容、Token。

---

# 19. PR 自检清单

- [ ] 使用 pnpm，`pnpm-lock.yaml` 已随依赖变更更新。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm format:check` 全部通过。
- [ ] 所有函数、组件、Hook、Store Action 均有符合 §15.2 的注释；复杂逻辑有 §15.4 要求的行内注释。
- [ ] 没有业务规则写在前端；没有直接 `invoke`；没有 `fetch`。
- [ ] 修改了 Rust Command / DTO 时已执行 `pnpm gen:bindings`。
- [ ] 新增用户可见文本已加入 `zh-CN` 与 `en` 资源文件。
- [ ] 新增颜色 / 间距 / 时长使用 Design Token。
- [ ] 悬浮窗相关改动未在 Hover 路径引入 IPC。
- [ ] 高频操作使用 Optimistic Update，并测试了失败回滚。
- [ ] 实施计划中对应子阶段的状态已更新。

---

# 20. 变更记录

| 日期 | 版本 | 说明 |
|---|---|---|
| 2026-10-09 | v1.0 | 初版 |
