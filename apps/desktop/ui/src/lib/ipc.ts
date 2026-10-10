import { isTauri } from "@tauri-apps/api/core";
import { commands, events } from "@/bindings";
import type {
  CaptureRequestDto,
  CaptureResultDto,
  CreateItemRequest,
  ExpandedLayoutDto,
  IpcError,
  ItemDto,
  ItemTypeDto,
  ListItemsRequest,
  RescheduleTargetDto,
  TodayViewDto,
} from "@/bindings";
import { toAppError } from "./errors";

export type {
  CaptureInputDto,
  CaptureOriginDto,
  CaptureRequestDto,
  CaptureResultDto,
  ContentFormatDto,
  CreateItemRequest,
  DatePointDto,
  ExpandedLayoutDto,
  ItemDto,
  ItemStatusDto,
  ItemTypeDto,
  ListItemsRequest,
  PriorityDto,
  RescheduleTargetDto,
  TodayItemDto,
  TodayViewDto,
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
  /** 按 ID 读取一个 Item。 */
  getItem(id: string): Promise<ItemDto>;
  /** 列出 Item，创建时间从新到旧。 */
  listItems(request: ListItemsRequest): Promise<ItemDto[]>;
  /**
   * 快速创建（悬浮窗 Quick Create）：只需要类型与标题，日期等默认值由后端决定
   * （Todo 与 Tip 的计划日期是今天，Note 没有日期）。
   */
  quickCreate(itemType: ItemTypeDto, title: string): Promise<ItemDto>;
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
  /** 撤销一次捕获：删除它创建的全部记录（用户被引用的文件不受影响）。 */
  undoCapture(itemIds: string[]): Promise<void>;
  /** 打开（必要时创建）并聚焦主窗口。 */
  openMain(): Promise<void>;
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
  listItems: (request) => call("list_items", commands.listItems(request)),
  quickCreate: (itemType, title) => call("quick_create", commands.quickCreate({ itemType, title })),
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
  openMain: async () => {
    await call("open_main", commands.openMain());
  },
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
  listItems: (request) => current.listItems(request),
  quickCreate: (itemType, title) => current.quickCreate(itemType, title),
  rescheduleItem: (id, target) => current.rescheduleItem(id, target),
  reorderToday: (orderedIds) => current.reorderToday(orderedIds),
  completeItem: (id) => current.completeItem(id),
  reopenItem: (id) => current.reopenItem(id),
  getToday: () => current.getToday(),
  capture: (request) => current.capture(request),
  undoCapture: (itemIds) => current.undoCapture(itemIds),
  openMain: () => current.openMain(),
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
