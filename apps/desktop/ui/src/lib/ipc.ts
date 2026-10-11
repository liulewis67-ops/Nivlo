import { isTauri } from "@tauri-apps/api/core";
import { commands, events } from "@/bindings";
import type {
  AppSettingsDto,
  CalendarDto,
  CalendarRequest,
  CaptureRequestDto,
  CaptureResultDto,
  CreateItemRequest,
  DatePointDto,
  ExpandedLayoutDto,
  InboxEntryDto,
  IpcError,
  ItemDto,
  ItemTypeDto,
  LaterRuleDto,
  ListItemsRequest,
  OrganizeActionDto,
  OrganizeResultDto,
  PreviousStateDto,
  ProjectDto,
  RescheduleTargetDto,
  ShortcutStatusDto,
  TagDto,
  TagSummaryDto,
  TodayViewDto,
  TrashEntryDto,
  UpdateItemRequest,
  WeekStartDto,
  DryRunInputDto,
  DryRunResultDto,
  ExportResultDto,
  RestoreStagedDto,
  WorkflowDto,
  WorkflowRunDto,
} from "@/bindings";
import { toAppError } from "./errors";

export type {
  AppSettingsDto,
  CalendarDto,
  CalendarEntryDto,
  CalendarItemDto,
  CalendarRequest,
  EntryKindDto,
  WeekStartDto,
  LaterRuleDto,
  ItemOrderDto,
  AttachmentDto,
  CaptureInputDto,
  CaptureOriginDto,
  CaptureRequestDto,
  CaptureResultDto,
  ContentFormatDto,
  CreateItemRequest,
  DatePointDto,
  ExpandedLayoutDto,
  InboxEntryDto,
  ItemDto,
  ItemStatusDto,
  ItemTypeDto,
  ListItemsRequest,
  OrganizeActionDto,
  OrganizeResultDto,
  PatchDto,
  PreviousStateDto,
  PriorityDto,
  ProjectDto,
  RescheduleTargetDto,
  ScheduleTargetDto,
  ShortcutStatusDto,
  SourceDto,
  TagDto,
  TagSummaryDto,
  TodayItemDto,
  TodayViewDto,
  TrashEntryDto,
  UpdateItemRequest,
  DryRunInputDto,
  DryRunResultDto,
  ExportResultDto,
  RestoreStagedDto,
  PlannedItemDto,
  StepReportDto,
  WorkflowDto,
  WorkflowRunDto,
} from "@/bindings";

/**
 * 前端可用的 IPC 能力，与后端 Use Case 一一对应。
 *
 * 生产环境由 Tauri Binding 实现；Vitest 与 `pnpm dev:ui` 使用内存 Mock（`test/ipc-mock.ts`）。
 * 调用失败时抛出 [`AppError`](./errors.ts)，而不是返回 `Result`。
 */
export interface IpcClient {
  /** 创建一个 Item。 */
  createItem(request: CreateItemRequest): Promise<ItemDto>;
  /** 读取一个 Item 的详情：Item 本身加上来源与附件（含被引用文件是否还在）。 */
  getItemDetail(id: string): Promise<InboxEntryDto>;
  /**
   * 更新一个 Item：只修改请求里出现的字段，在一个事务里完成（详情面板的自动保存）。
   * 违反领域规则抛出对应错误码，此时没有任何改动。
   */
  updateItem(id: string, request: UpdateItemRequest): Promise<ItemDto>;
  /**
   * 打开 Item 的来源：网址用默认浏览器，文件在资源管理器里定位。
   * 文件已不在原处抛出 `SOURCE_FILE_MISSING`；没有可打开的来源抛出 `SOURCE_OPEN_FAILED`。
   */
  openItemSource(id: string): Promise<void>;
  /** 按 ID 读取一个 Item。 */
  getItem(id: string): Promise<ItemDto>;
  /** 列出 Item，创建时间从新到旧。 */
  listItems(request: ListItemsRequest): Promise<ItemDto[]>;
  /**
   * 快速创建（悬浮窗 Quick Create）：只需要类型与标题，日期等默认值由后端决定
   * （Todo 与 Tip 的计划日期是今天，Note 没有日期）。
   */
  quickCreate(
    itemType: ItemTypeDto,
    title: string,
    scheduled?: DatePointDto | null,
  ): Promise<ItemDto>;
  /** 完成一个 Todo（完成不改变它在 Today 中的位置记录，撤销后回到原位）。 */
  completeItem(id: string): Promise<ItemDto>;
  /** 重新打开已完成的 Todo，也是「完成」的撤销。 */
  reopenItem(id: string): Promise<ItemDto>;
  /**
   * 改期（推迟）一个 Item：今天 / 明天 / 稍后（下周一）/ 收集箱，或 `exact` 精确恢复（撤销）。
   * Item 同时离开 Today 的手动顺序。
   */
  rescheduleItem(id: string, target: RescheduleTargetDto): Promise<ItemDto>;
  /**
   * 保存 Today 待办的手动顺序（从上到下的 Item ID）。后端会规范化，不会丢失界面不知道的新待办。
   */
  reorderToday(orderedIds: string[]): Promise<void>;
  /**
   * 读取今天的视图（待办 / 提示 / 今日已完成）。
   *
   * 悬浮窗只在启动时调用一次，之后由数据变更事件驱动刷新；Hover 展开不会调用它。
   */
  getToday(): Promise<TodayViewDto>;
  /**
   * 捕获一次输入（拖放 / 粘贴 / 快捷键）：在一个事务里创建 Item + 来源 + 附件并放进 Inbox。
   * 返回创建的 Item 与撤销句柄（传给 [`IpcClient.undoCapture`]）。
   */
  capture(request: CaptureRequestDto): Promise<CaptureResultDto>;
  /**
   * 读取剪贴板并捕获（用户按了粘贴）：文件 → 文本 → 图片。
   * 剪贴板里没有可收集的内容抛出 `CLIPBOARD_EMPTY`，读取失败抛出 `CLIPBOARD_UNAVAILABLE`。
   */
  captureFromClipboard(): Promise<CaptureResultDto>;
  /** 撤销一次捕获：删除它创建的全部记录（用户被引用的文件不受影响）。 */
  undoCapture(itemIds: string[]): Promise<void>;
  /** 列出 Inbox：等待整理的 Item（捕获时间从新到旧），附带来源与附件（含被引用文件是否还在）。 */
  listInbox(): Promise<InboxEntryDto[]>;
  /** Inbox 里有多少条等待整理。 */
  getInboxCount(): Promise<number>;
  /**
   * 对一批 Item 执行同一个整理动作（一个事务，任何一条失败整批不变）。
   * 返回整理之后的 Item 与整理之前的状态（传给 [`IpcClient.restoreItems`] 撤销）。
   */
  organizeItems(itemIds: string[], action: OrganizeActionDto): Promise<OrganizeResultDto>;
  /** 精确撤销一次整理：恢复到 [`PreviousStateDto`] 记录的状态。 */
  restoreItems(previous: PreviousStateDto[]): Promise<ItemDto[]>;
  /**
   * 全文搜索（Ctrl+K）：标题、正文与来源里包含 `query` 的未归档条目，标题命中的在前，最多 50 条。
   * 空白查询返回空列表。
   */
  searchItems(query: string): Promise<ItemDto[]>;
  /** 读取设置页的全部设置：开机自启（以系统启动项为准）、悬浮窗置顶、「稍后」的规则。 */
  getAppSettings(): Promise<AppSettingsDto>;
  /** 开启 / 关闭开机自启，返回之后的实际状态；系统拒绝时抛出 `SYSTEM_SETTING_FAILED`。 */
  setAutostart(enabled: boolean): Promise<boolean>;
  /** 设置悬浮窗是否置顶，立即生效并保存。 */
  setFloatingAlwaysOnTop(enabled: boolean): Promise<void>;
  /** 修改「稍后」的规则（悬浮窗与收集箱的「稍后」按钮都按它算日期）。 */
  setLaterRule(rule: LaterRuleDto): Promise<void>;
  /**
   * 查询 Calendar：可见范围（月视图的整周网格 / 周视图的一周）内的计划与截止条目，
   * 以及还没有安排日期的待办。范围由后端按「一周从哪天开始」的设置计算。
   */
  getCalendar(request: CalendarRequest): Promise<CalendarDto>;
  /** 记录首次运行引导看过了（`true`），或让它下次重新出现（`false`）。 */
  setOnboardingCompleted(completed: boolean): Promise<void>;
  /** 修改日历一周从哪天开始。 */
  setWeekStart(weekStart: WeekStartDto): Promise<void>;
  /**
   * 暂停 / 恢复系统通知（与托盘的「暂停通知」同一个开关）。暂停期间到点的提醒不会丢：
   * 恢复后作为「错过的提醒」通知，多了合并成一条汇总。
   */
  setNotificationsPaused(paused: boolean): Promise<void>;
  /**
   * 删除一批条目：移进回收站（软删除），30 天内可以恢复。一个事务，任何一个不存在整批不变。
   * 条目立刻从所有视图与搜索里消失。
   */
  deleteItems(ids: string[]): Promise<void>;
  /** 从回收站恢复一批条目（「删除」的撤销）；不在回收站里的被忽略。 */
  restoreDeletedItems(ids: string[]): Promise<void>;
  /** 回收站里的全部条目（最近删除的在前），带到期（自动永久清除）时间。 */
  listTrash(): Promise<TrashEntryDto[]>;
  /**
   * 永久删除回收站里的这些条目；不在回收站里的不会被删除。返回实际删除的数量。
   * 只删除记录与 Nivlo 自己保存的文件，被引用的用户文件不受影响。
   */
  purgeItems(ids: string[]): Promise<number>;
  /** 清空回收站，返回删除的数量。 */
  emptyTrash(): Promise<number>;
  /** 导出诊断包（环境、Workflow 元数据、脱敏日志），并在文件管理器中显示；返回 zip 的路径。 */
  exportDiagnostics(): Promise<string>;
  /** 创建备份包（数据库快照 + 附件），在文件管理器中显示；返回路径。 */
  createBackupFile(): Promise<string>;
  /** 导出全部笔记 / 待办：`json`、`markdown`（单文件）、`markdownFiles`（每条一个文件，压缩包）。 */
  exportData(format: "json" | "markdown" | "markdownFiles"): Promise<ExportResultDto>;
  /**
   * 从备份恢复：选择备份包 → 校验 → 先自动备份当前数据 → 暂存，重启后生效。
   * 用户取消选择时返回 `null`；备份无效抛出 `EXPORT_FAILED`。
   */
  restoreBackup(): Promise<RestoreStagedDto | null>;
  /** 重启应用（让暂存的恢复生效）。 */
  restartApp(): Promise<void>;
  /** 全部 Workflow：内置在前，其次是用户的，各自按优先级从大到小。 */
  listWorkflows(): Promise<WorkflowDto[]>;
  /** 启用 / 禁用一个 Workflow（内置的也可以）。 */
  setWorkflowEnabled(id: string, enabled: boolean): Promise<void>;
  /** 调整优先级：数字大的先匹配。 */
  setWorkflowPriority(id: string, priority: number): Promise<void>;
  /** 复制出一份可编辑的用户副本（优先级比原件高，所以先于原件生效）。 */
  duplicateWorkflow(id: string): Promise<WorkflowDto>;
  /** 保存一个用户 Workflow；定义没通过校验抛出 `WORKFLOW_INVALID`（消息里带位置），覆盖内置抛出 `WORKFLOW_READ_ONLY`。 */
  saveWorkflow(definitionJson: string): Promise<WorkflowDto>;
  /** 删除用户 Workflow；内置的不能删除。 */
  deleteWorkflow(id: string): Promise<void>;
  /** 试运行：用样例预览会创建什么，不写任何数据。 */
  dryRunWorkflow(definitionJson: string, input: DryRunInputDto): Promise<DryRunResultDto>;
  /** 重新运行 Workflow：按条目的来源重新匹配并完整运行，更新标题与内容；返回是否有变化。 */
  rerunWorkflow(id: string): Promise<boolean>;
  /** 最近的运行记录（新的在前）。 */
  listWorkflowRuns(limit?: number): Promise<WorkflowRunDto[]>;
  /** 列出项目（创建时间从早到晚）与各自未完成的 Item 数量；默认不含已归档的。 */
  listProjects(includeArchived: boolean): Promise<ProjectDto[]>;
  /** 创建项目。名称为空抛出 `NAME_EMPTY`，过长抛出 `NAME_TOO_LONG`。 */
  createProject(name: string): Promise<ProjectDto>;
  /** 重命名项目。 */
  renameProject(id: string, name: string): Promise<ProjectDto>;
  /** 归档项目：它从侧栏消失，里面的 Item 不受影响。 */
  archiveProject(id: string): Promise<ProjectDto>;
  /** 取消归档项目（归档的撤销）。 */
  unarchiveProject(id: string): Promise<ProjectDto>;
  /** 全部标签与各自的 Item 数量（按名称排序），标签管理与自动补全共用。 */
  listTags(): Promise<TagSummaryDto[]>;
  /** 重命名标签，所有关联的 Item 同步更新。与另一个标签重名抛出 `TAG_NAME_TAKEN`。 */
  renameTag(id: string, name: string): Promise<TagDto>;
  /** 把标签 `from` 合并进 `into`，返回留下的标签。 */
  mergeTags(from: string, into: string): Promise<TagDto>;
  /** 用 `names` 整体替换某个 Item 的标签（不存在的自动创建），返回替换后的标签。 */
  setItemTags(id: string, names: string[]): Promise<TagDto[]>;
  /** 打开（必要时创建）并聚焦主窗口。 */
  openMain(): Promise<void>;
  /** 读取 Quick Create 全局快捷键的绑定与注册状态；被其他程序占用时 `conflict` 为 `true`。 */
  getShortcutStatus(): Promise<ShortcutStatusDto>;
  /**
   * 修改 Quick Create 的全局快捷键并保存（如 `Ctrl+Alt+Q`）。
   * 不合法抛出 `SHORTCUT_INVALID`，被占用抛出 `SHORTCUT_CONFLICT`，此时原来的绑定保持不变。
   */
  setQuickCreateShortcut(accelerator: string): Promise<ShortcutStatusDto>;
  /** 打开主窗口并切换到指定视图（`inbox` / `today` / `calendar` / `notes` / `projects`）。 */
  openMainAt(view: string): Promise<void>;
  /**
   * 取走悬浮窗请求主窗口打开的视图（主窗口启动时调用一次）；没有请求时为 `null`。
   * 主窗口可能刚被创建、还没开始监听事件，所以请求先存在后端。
   */
  takePendingMainView(): Promise<string | null>;
  /**
   * 订阅「请求主窗口切换视图」事件（主窗口已经在运行时由它通知）。
   *
   * @param onRequested 事件到达时的回调，参数是目标视图。
   * @returns 取消订阅的函数，组件卸载时必须调用。
   */
  subscribeMainViewRequested(onRequested: (view: string) => void): () => void;
  /** 退出应用：触发后端的有序退出流程。仅主窗口可调用。 */
  quitApp(): Promise<void>;
  /**
   * 请求后端开始拖动悬浮窗（交给操作系统的原生拖动，保证跟手）。
   * 窗口位置始终由 Rust 控制，前端不直接移动窗口。
   */
  startFloatingDrag(): Promise<void>;
  /**
   * 把悬浮窗展开为 Today 面板（窗口几何命令，不查询任何业务数据）。
   *
   * @param width 面板宽度（logical px）。
   * @param height 面板高度（logical px）。
   * @returns 展开方向，用于设置面板动画的 transform-origin。
   */
  expandFloating(width: number, height: number): Promise<ExpandedLayoutDto>;
  /** 把悬浮窗收起回徽标，位置与展开前一致。 */
  collapseFloating(): Promise<void>;
  /**
   * 开始悬浮窗的文本输入：后端记住用户当前的前台窗口，悬浮窗临时可聚焦并获得键盘焦点。
   * 必须与 [`IpcClient.endFloatingInput`] 成对使用。
   */
  beginFloatingInput(): Promise<void>;
  /** 结束文本输入：悬浮窗恢复不可聚焦，焦点还给用户之前的应用。可重复调用。 */
  endFloatingInput(): Promise<void>;
  /**
   * 订阅"悬浮窗指针已离开"事件。
   *
   * WebView 在指针被快速甩出窗口时可能不投递 `pointerleave`，后端看门狗会补发这个事件，
   * 前端据此把"指针离开"送进状态机，避免面板一直停在展开状态。
   *
   * @param onLeft 事件到达时的回调。
   * @returns 取消订阅的函数，组件卸载时必须调用。
   */
  subscribeFloatingPointerLeft(onLeft: () => void): () => void;
  /**
   * 订阅「托盘快速添加」事件：悬浮窗应展开并进入快速创建（默认创建待办）。
   *
   * @param onRequested 事件到达时的回调。
   * @returns 取消订阅的函数，组件卸载时必须调用。
   */
  subscribeQuickAddRequested(onRequested: () => void): () => void;
  /**
   * 订阅"数据发生了变化"的后端事件：Item 创建 / 更新、Today 顺序调整、本地日期切换。
   *
   * @param onChange 事件到达时的回调；事件只是"该刷新了"的信号，调用方应当让相关查询缓存失效。
   * @returns 取消订阅的函数，组件卸载时必须调用。
   */
  subscribeDataChanges(onChange: () => void): () => void;
}

/** 生成的 Binding 返回的 Result 形状。 */
type BindingResult<T> = { status: "ok"; data: T } | { status: "error"; error: IpcError };

/**
 * 调用一个 Command 并解包结果：成功返回数据，失败抛出 `AppError`。
 *
 * 开发模式下记录命令名与耗时，便于发现慢调用。
 *
 * @param name 命令名，只用于日志。
 * @param pending Binding 返回的 Promise。
 * @returns Command 的成功数据。
 * @throws {AppError} 后端返回错误，或调用本身失败时。
 */
async function call<T>(name: string, pending: Promise<BindingResult<T>>): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await pending;
    if (result.status === "error") throw toAppError(result.error);
    return result.data;
  } catch (error) {
    throw toAppError(error);
  } finally {
    if (import.meta.env.DEV) {
      console.debug(`[ipc] ${name} ${(performance.now() - startedAt).toFixed(1)}ms`);
    }
  }
}

/**
 * 同时注册多个事件监听，并返回同步的取消函数。
 *
 * `listen` 是异步的：如果在注册完成之前就取消，需要在注册完成后立刻补做取消，避免泄漏监听。
 *
 * @param register 各自注册监听并返回 `unlisten` 的函数列表。
 * @returns 取消全部订阅的函数。
 */
function listenAll(register: Array<() => Promise<() => void>>): () => void {
  let cancelled = false;
  const unlisteners: Array<() => void> = [];
  for (const start of register) {
    void start().then((unlisten) => {
      if (cancelled) unlisten();
      else unlisteners.push(unlisten);
    });
  }
  return () => {
    cancelled = true;
    for (const unlisten of unlisteners) unlisten();
    unlisteners.length = 0;
  };
}

/** 基于 Tauri Binding 的真实实现。 */
const tauriIpc: IpcClient = {
  createItem: (request) => call("create_item", commands.createItem(request)),
  getItem: (id) => call("get_item", commands.getItem(id)),
  getItemDetail: (id) => call("get_item_detail", commands.getItemDetail(id)),
  updateItem: (id, request) => call("update_item", commands.updateItem(id, request)),
  openItemSource: async (id) => {
    await call("open_item_source", commands.openItemSource(id));
  },
  listItems: (request) => call("list_items", commands.listItems(request)),
  getAppSettings: () => call("get_app_settings", commands.getAppSettings()),
  setAutostart: (enabled) => call("set_autostart", commands.setAutostart(enabled)),
  setFloatingAlwaysOnTop: async (enabled) => {
    await call("set_floating_always_on_top", commands.setFloatingAlwaysOnTop(enabled));
  },
  setLaterRule: async (rule) => {
    await call("set_later_rule", commands.setLaterRule(rule));
  },
  getCalendar: (request) => call("get_calendar", commands.getCalendar(request)),
  setOnboardingCompleted: async (completed) => {
    await call("set_onboarding_completed", commands.setOnboardingCompleted(completed));
  },
  setNotificationsPaused: async (paused) => {
    await call("set_notifications_paused", commands.setNotificationsPaused(paused));
  },
  setWeekStart: async (weekStart) => {
    await call("set_week_start", commands.setWeekStart(weekStart));
  },
  deleteItems: async (ids) => {
    await call("delete_items", commands.deleteItems(ids));
  },
  restoreDeletedItems: async (ids) => {
    await call("restore_deleted_items", commands.restoreDeletedItems(ids));
  },
  listTrash: () => call("list_trash", commands.listTrash()),
  purgeItems: (ids) => call("purge_items", commands.purgeItems(ids)),
  emptyTrash: () => call("empty_trash", commands.emptyTrash()),
  exportDiagnostics: () => call("export_diagnostics", commands.exportDiagnostics()),
  createBackupFile: () => call("create_backup_file", commands.createBackupFile()),
  exportData: (format) => call("export_data", commands.exportData(format)),
  restoreBackup: () => call("restore_backup", commands.restoreBackup()),
  restartApp: () => commands.restartApp(),
  listWorkflows: () => call("list_workflows", commands.listWorkflows()),
  setWorkflowEnabled: async (id, enabled) => {
    await call("set_workflow_enabled", commands.setWorkflowEnabled(id, enabled));
  },
  setWorkflowPriority: async (id, priority) => {
    await call("set_workflow_priority", commands.setWorkflowPriority(id, priority));
  },
  duplicateWorkflow: (id) => call("duplicate_workflow", commands.duplicateWorkflow(id)),
  saveWorkflow: (definitionJson) => call("save_workflow", commands.saveWorkflow(definitionJson)),
  deleteWorkflow: async (id) => {
    await call("delete_workflow", commands.deleteWorkflow(id));
  },
  dryRunWorkflow: (definitionJson, input) =>
    call("dry_run_workflow", commands.dryRunWorkflow(definitionJson, input)),
  rerunWorkflow: (id) => call("rerun_workflow", commands.rerunWorkflow(id)),
  listWorkflowRuns: (limit) => call("list_workflow_runs", commands.listWorkflowRuns(limit ?? null)),
  searchItems: (query) => call("search_items", commands.searchItems(query)),
  listProjects: (includeArchived) => call("list_projects", commands.listProjects(includeArchived)),
  createProject: (name) => call("create_project", commands.createProject(name)),
  renameProject: (id, name) => call("rename_project", commands.renameProject(id, name)),
  archiveProject: (id) => call("archive_project", commands.archiveProject(id)),
  unarchiveProject: (id) => call("unarchive_project", commands.unarchiveProject(id)),
  listTags: () => call("list_tags", commands.listTags()),
  renameTag: (id, name) => call("rename_tag", commands.renameTag(id, name)),
  mergeTags: (from, into) => call("merge_tags", commands.mergeTags(from, into)),
  setItemTags: (id, names) => call("set_item_tags", commands.setItemTags(id, names)),
  quickCreate: (itemType, title, scheduled) =>
    call("quick_create", commands.quickCreate({ itemType, title, scheduled: scheduled ?? null })),
  rescheduleItem: (id, target) => call("reschedule_item", commands.rescheduleItem(id, target)),
  reorderToday: async (orderedIds) => {
    await call("reorder_today", commands.reorderToday(orderedIds));
  },
  completeItem: (id) => call("complete_item", commands.completeItem(id)),
  reopenItem: (id) => call("reopen_item", commands.reopenItem(id)),
  getToday: () => call("get_today", commands.getToday()),
  capture: (request) => call("capture", commands.capture(request)),
  undoCapture: async (itemIds) => {
    await call("undo_capture", commands.undoCapture(itemIds));
  },
  captureFromClipboard: () => call("capture_from_clipboard", commands.captureFromClipboard()),
  listInbox: () => call("list_inbox", commands.listInbox()),
  getInboxCount: () => call("get_inbox_count", commands.getInboxCount()),
  organizeItems: (itemIds, action) =>
    call("organize_items", commands.organizeItems(itemIds, action)),
  restoreItems: (previous) => call("restore_items", commands.restoreItems(previous)),
  openMain: async () => {
    await call("open_main", commands.openMain());
  },
  getShortcutStatus: () => call("get_shortcut_status", commands.getShortcutStatus()),
  setQuickCreateShortcut: (accelerator) =>
    call("set_quick_create_shortcut", commands.setQuickCreateShortcut(accelerator)),
  openMainAt: async (view) => {
    await call("open_main_at", commands.openMainAt(view));
  },
  takePendingMainView: () => call("take_pending_main_view", commands.takePendingMainView()),
  subscribeMainViewRequested: (onRequested) =>
    listenAll([() => events.mainViewRequested.listen((event) => onRequested(event.payload.view))]),
  quitApp: () => commands.quitApp(),
  startFloatingDrag: async () => {
    await call("start_floating_drag", commands.startFloatingDrag());
  },
  expandFloating: (width, height) =>
    call("expand_floating", commands.expandFloating({ width, height })),
  collapseFloating: async () => {
    await call("collapse_floating", commands.collapseFloating());
  },
  beginFloatingInput: async () => {
    await call("begin_floating_input", commands.beginFloatingInput());
  },
  endFloatingInput: async () => {
    await call("end_floating_input", commands.endFloatingInput());
  },
  subscribeFloatingPointerLeft: (onLeft) =>
    listenAll([() => events.floatingPointerLeft.listen(() => onLeft())]),
  subscribeQuickAddRequested: (onRequested) =>
    listenAll([() => events.quickAddRequested.listen(() => onRequested())]),
  subscribeDataChanges: (onChange) =>
    listenAll([
      () => events.itemCreated.listen(() => onChange()),
      () => events.itemUpdated.listen(() => onChange()),
      () => events.todayReordered.listen(() => onChange()),
      () => events.dayChanged.listen(() => onChange()),
    ]),
};

/** 当前生效的实现；测试与浏览器预览通过 [`setIpcClient`] 替换。 */
let current: IpcClient = tauriIpc;

/**
 * 替换当前的 IPC 实现（测试或纯 UI 预览时使用）。
 *
 * @param client 新的实现。
 */
export function setIpcClient(client: IpcClient): void {
  current = client;
}

/**
 * 是否运行在 Tauri WebView 中；在普通浏览器（`pnpm dev:ui`）中为 `false`。
 *
 * @returns 运行在 Tauri 中时为 `true`。
 */
export function isRunningInTauri(): boolean {
  return isTauri();
}

/** 全局 IPC 入口：所有调用委托给当前生效的实现。 */
export const ipc: IpcClient = {
  createItem: (request) => current.createItem(request),
  getItem: (id) => current.getItem(id),
  getItemDetail: (id) => current.getItemDetail(id),
  updateItem: (id, request) => current.updateItem(id, request),
  openItemSource: (id) => current.openItemSource(id),
  listItems: (request) => current.listItems(request),
  getAppSettings: () => current.getAppSettings(),
  setAutostart: (enabled) => current.setAutostart(enabled),
  setFloatingAlwaysOnTop: (enabled) => current.setFloatingAlwaysOnTop(enabled),
  setLaterRule: (rule) => current.setLaterRule(rule),
  getCalendar: (request) => current.getCalendar(request),
  setWeekStart: (weekStart) => current.setWeekStart(weekStart),
  setNotificationsPaused: (paused) => current.setNotificationsPaused(paused),
  setOnboardingCompleted: (completed) => current.setOnboardingCompleted(completed),
  deleteItems: (ids) => current.deleteItems(ids),
  restoreDeletedItems: (ids) => current.restoreDeletedItems(ids),
  listTrash: () => current.listTrash(),
  purgeItems: (ids) => current.purgeItems(ids),
  emptyTrash: () => current.emptyTrash(),
  exportDiagnostics: () => current.exportDiagnostics(),
  createBackupFile: () => current.createBackupFile(),
  exportData: (format) => current.exportData(format),
  restoreBackup: () => current.restoreBackup(),
  restartApp: () => current.restartApp(),
  listWorkflows: () => current.listWorkflows(),
  setWorkflowEnabled: (id, enabled) => current.setWorkflowEnabled(id, enabled),
  setWorkflowPriority: (id, priority) => current.setWorkflowPriority(id, priority),
  duplicateWorkflow: (id) => current.duplicateWorkflow(id),
  saveWorkflow: (definitionJson) => current.saveWorkflow(definitionJson),
  deleteWorkflow: (id) => current.deleteWorkflow(id),
  dryRunWorkflow: (definitionJson, input) => current.dryRunWorkflow(definitionJson, input),
  rerunWorkflow: (id) => current.rerunWorkflow(id),
  listWorkflowRuns: (limit) => current.listWorkflowRuns(limit),
  searchItems: (query) => current.searchItems(query),
  listProjects: (includeArchived) => current.listProjects(includeArchived),
  createProject: (name) => current.createProject(name),
  renameProject: (id, name) => current.renameProject(id, name),
  archiveProject: (id) => current.archiveProject(id),
  unarchiveProject: (id) => current.unarchiveProject(id),
  listTags: () => current.listTags(),
  renameTag: (id, name) => current.renameTag(id, name),
  mergeTags: (from, into) => current.mergeTags(from, into),
  setItemTags: (id, names) => current.setItemTags(id, names),
  quickCreate: (itemType, title, scheduled) => current.quickCreate(itemType, title, scheduled),
  rescheduleItem: (id, target) => current.rescheduleItem(id, target),
  reorderToday: (orderedIds) => current.reorderToday(orderedIds),
  completeItem: (id) => current.completeItem(id),
  reopenItem: (id) => current.reopenItem(id),
  getToday: () => current.getToday(),
  capture: (request) => current.capture(request),
  undoCapture: (itemIds) => current.undoCapture(itemIds),
  captureFromClipboard: () => current.captureFromClipboard(),
  listInbox: () => current.listInbox(),
  getInboxCount: () => current.getInboxCount(),
  organizeItems: (itemIds, action) => current.organizeItems(itemIds, action),
  restoreItems: (previous) => current.restoreItems(previous),
  openMain: () => current.openMain(),
  getShortcutStatus: () => current.getShortcutStatus(),
  setQuickCreateShortcut: (accelerator) => current.setQuickCreateShortcut(accelerator),
  openMainAt: (view) => current.openMainAt(view),
  takePendingMainView: () => current.takePendingMainView(),
  subscribeMainViewRequested: (onRequested) => current.subscribeMainViewRequested(onRequested),
  quitApp: () => current.quitApp(),
  startFloatingDrag: () => current.startFloatingDrag(),
  expandFloating: (width, height) => current.expandFloating(width, height),
  collapseFloating: () => current.collapseFloating(),
  beginFloatingInput: () => current.beginFloatingInput(),
  endFloatingInput: () => current.endFloatingInput(),
  subscribeFloatingPointerLeft: (onLeft) => current.subscribeFloatingPointerLeft(onLeft),
  subscribeQuickAddRequested: (onRequested) => current.subscribeQuickAddRequested(onRequested),
  subscribeDataChanges: (onChange) => current.subscribeDataChanges(onChange),
};
