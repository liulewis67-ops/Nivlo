import { AppError } from "@/lib/errors";
import type {
  CreateItemRequest,
  ItemDto,
  IpcClient,
  ItemTypeDto,
  ListItemsRequest,
  RescheduleTargetDto,
  TodayItemDto,
  TodayViewDto,
} from "@/lib/ipc";

/** 标题允许的最大字符数，与后端 `MAX_TITLE_CHARS` 保持一致。 */
const MAX_TITLE_CHARS = 500;

/** 没有任何数据时的 Today 视图。 */
export const EMPTY_TODAY: TodayViewDto = {
  date: "2026-10-10",
  remainingCount: 0,
  todos: [],
  tips: [],
  completed: [],
};

/** 内存版 IPC 额外暴露的、仅供测试使用的能力。 */
export interface MemoryIpc extends IpcClient {
  /** 当前保存的全部 Item（按创建顺序）。 */
  readonly items: readonly ItemDto[];
  /** `openMain` 被调用的次数。 */
  readonly openMainCalls: number;
  /** `startFloatingDrag` 被调用的次数。 */
  readonly dragStarts: number;
  /** 按顺序记录的全部方法调用名，用于断言"没有发起某些 IPC"。 */
  readonly calls: readonly string[];
  /** 让下一次 `quickCreate` 抛出的错误，用于测试失败路径；触发后自动清除。 */
  failNextQuickCreateWith(error: AppError): void;
  /** 按顺序记录的全部 `rescheduleItem` 调用。 */
  readonly reschedules: readonly { id: string; target: RescheduleTargetDto }[];
  /** 最近一次 `reorderToday` 收到的 ID 顺序。 */
  readonly lastReorder: string[] | null;
  /** 让下一次 `completeItem` / `reopenItem` / `reorderToday` 抛出的错误，用于测试回滚；触发后自动清除。 */
  failNextTransitionWith(error: AppError): void;
  /** 让下一次 `beginFloatingInput` 抛出的错误（模拟窗口无法聚焦）。 */
  failNextBeginInputWith(error: AppError): void;
  /** 设置下一次及之后 `getToday` 返回的 Today 视图。 */
  setToday(view: TodayViewDto): void;
  /** 模拟后端发出一次数据变更事件（`item_created` / `day_changed` 等）。 */
  emitDataChange(): void;
  /** 模拟后端看门狗补发"指针已离开"事件。 */
  emitFloatingPointerLeft(): void;
  /** 最近一次 `expandFloating` 请求的尺寸。 */
  readonly lastExpand: { width: number; height: number } | null;
}

/** 创建内存版 IPC 时的可选配置。 */
export type MemoryIpcOptions = {
  /** 让下一次 `createItem` 抛出的错误，用于测试失败路径；触发后自动清除。 */
  failNextCreateWith?: AppError;
};

/**
 * 创建与 Binding 同签名的内存版 IPC。
 *
 * 用于 Vitest 与 `pnpm dev:ui`。行为刻意对齐后端的关键规则（标题去空白且非空、
 * 从新到旧排序、创建后通知订阅者），这样界面逻辑在没有 Rust 时也能被验证。
 * 数据形状全部使用生成的类型。
 *
 * @param options 可选配置。
 * @returns 内存版 IPC。
 */
export function createMemoryIpc(options: MemoryIpcOptions = {}): MemoryIpc {
  const items: ItemDto[] = [];
  const listeners = new Set<() => void>();
  const pointerLeftListeners = new Set<() => void>();
  let pendingFailure = options.failNextCreateWith;
  let openMainCalls = 0;
  let dragStarts = 0;
  let quickCreateFailure: AppError | undefined;
  let beginInputFailure: AppError | undefined;
  let transitionFailure: AppError | undefined;
  let lastReorder: string[] | null = null;
  const reschedules: { id: string; target: RescheduleTargetDto }[] = [];
  /** 被推迟出 Today 的条目，供「精确恢复」放回。 */
  const postponed = new Map<string, TodayItemDto>();
  let today: TodayViewDto = EMPTY_TODAY;
  const calls: string[] = [];
  let lastExpand: { width: number; height: number } | null = null;

  /** 校验并插入一个 Item，行为对齐后端（标题去空白且非空、有长度上限），并通知订阅者。 */
  function insert(request: CreateItemRequest): Promise<ItemDto> {
    const title = request.title.trim();
    if (title.length === 0) {
      return Promise.reject(new AppError("ITEM_TITLE_EMPTY", "标题为空"));
    }
    if ([...title].length > MAX_TITLE_CHARS) {
      return Promise.reject(new AppError("ITEM_TITLE_TOO_LONG", "标题过长"));
    }
    const now = new Date().toISOString();
    const item: ItemDto = {
      id: crypto.randomUUID(),
      itemType: request.itemType,
      title,
      content: request.content,
      contentFormat: request.contentFormat ?? "plain",
      status: "open",
      priority: request.priority ?? "none",
      scheduled: request.scheduled,
      due: request.due,
      reminderAt: request.reminderAt,
      projectId: request.projectId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null,
    };
    items.push(item);
    for (const notify of listeners) notify();
    return Promise.resolve(item);
  }

  /** 由 Today 条目构造一个 `ItemDto`（Mock 里 Item 与 Today 视图是分开维护的）。 */
  function itemFromToday(entry: TodayItemDto, status: "open" | "done"): ItemDto {
    return {
      id: entry.id,
      itemType: "todo",
      title: entry.title,
      content: null,
      contentFormat: "plain",
      status,
      priority: entry.priority,
      scheduled: entry.scheduled,
      due: entry.due,
      reminderAt: null,
      projectId: null,
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: "2026-10-10T00:00:00.000Z",
      completedAt: status === "done" ? "2026-10-10T00:00:00.000Z" : null,
      archivedAt: null,
    };
  }

  /**
   * 完成 / 重新打开：只作用于 Today 视图（Mock 里 Today 由测试直接设置）。
   * 重新打开时条目回到待办末尾，近似后端「顺序记录保留」的效果。
   */
  function transition(name: string, id: string, complete: boolean): Promise<ItemDto> {
    calls.push(name);
    if (transitionFailure !== undefined) {
      const failure = transitionFailure;
      transitionFailure = undefined;
      return Promise.reject(failure);
    }
    const source = complete ? today.todos : today.completed;
    const found = source.find((entry) => entry.id === id);
    if (found === undefined) {
      return Promise.reject(new AppError("ITEM_NOT_FOUND", `Item ${id} 不存在`));
    }
    today = complete
      ? {
          ...today,
          remainingCount: today.remainingCount - 1,
          todos: today.todos.filter((entry) => entry.id !== id),
          completed: [...today.completed, { ...found, status: "done" }],
        }
      : {
          ...today,
          remainingCount: today.remainingCount + 1,
          todos: [...today.todos, { ...found, status: "open" }],
          completed: today.completed.filter((entry) => entry.id !== id),
        };
    for (const notify of listeners) notify();
    return Promise.resolve(itemFromToday(found, complete ? "done" : "open"));
  }

  return {
    get items() {
      return items;
    },
    get openMainCalls() {
      return openMainCalls;
    },
    failNextQuickCreateWith: (error: AppError) => {
      quickCreateFailure = error;
    },
    failNextTransitionWith: (error: AppError) => {
      transitionFailure = error;
    },
    rescheduleItem: (id: string, target: RescheduleTargetDto) => {
      calls.push("rescheduleItem");
      reschedules.push({ id, target });
      if (transitionFailure !== undefined) {
        const failure = transitionFailure;
        transitionFailure = undefined;
        return Promise.reject(failure);
      }
      const inToday = today.todos.find((entry) => entry.id === id);
      const away = postponed.get(id);
      const found = inToday ?? away;
      if (found === undefined) {
        return Promise.reject(new AppError("ITEM_NOT_FOUND", `Item ${id} 不存在`));
      }
      // Mock 只模拟「离开 Today」与「精确恢复」两种效果。
      if (target.kind === "exact" && inToday === undefined) {
        postponed.delete(id);
        today = {
          ...today,
          remainingCount: today.remainingCount + 1,
          todos: [...today.todos, found],
        };
      } else if (target.kind !== "today" && target.kind !== "exact") {
        postponed.set(id, found);
        today = {
          ...today,
          remainingCount: today.remainingCount - 1,
          todos: today.todos.filter((entry) => entry.id !== id),
        };
      }
      for (const notify of listeners) notify();
      return Promise.resolve(itemFromToday(found, "open"));
    },
    get reschedules() {
      return reschedules;
    },
    reorderToday: (orderedIds: string[]) => {
      calls.push("reorderToday");
      lastReorder = orderedIds;
      if (transitionFailure !== undefined) {
        const failure = transitionFailure;
        transitionFailure = undefined;
        return Promise.reject(failure);
      }
      const byId = new Map(today.todos.map((entry) => [entry.id, entry]));
      const known = orderedIds.flatMap((id) => byId.get(id) ?? []);
      const rest = today.todos.filter((entry) => !orderedIds.includes(entry.id));
      today = { ...today, todos: [...known, ...rest] };
      for (const notify of listeners) notify();
      return Promise.resolve();
    },
    get lastReorder() {
      return lastReorder;
    },
    completeItem: (id: string) => transition("completeItem", id, true),
    reopenItem: (id: string) => transition("reopenItem", id, false),
    failNextBeginInputWith: (error: AppError) => {
      beginInputFailure = error;
    },
    quickCreate: (itemType: ItemTypeDto, title: string) => {
      calls.push("quickCreate");
      if (quickCreateFailure !== undefined) {
        const failure = quickCreateFailure;
        quickCreateFailure = undefined;
        return Promise.reject(failure);
      }
      // 与后端一致：Todo / Tip 默认今天，Note 没有日期。
      const scheduled = itemType === "note" ? null : { date: today.date, time: null };
      return insert({
        itemType,
        title,
        content: null,
        contentFormat: null,
        priority: null,
        scheduled,
        due: null,
        reminderAt: null,
        projectId: null,
      });
    },
    beginFloatingInput: () => {
      calls.push("beginFloatingInput");
      if (beginInputFailure !== undefined) {
        const failure = beginInputFailure;
        beginInputFailure = undefined;
        return Promise.reject(failure);
      }
      return Promise.resolve();
    },
    endFloatingInput: () => {
      calls.push("endFloatingInput");
      return Promise.resolve();
    },
    setToday: (view: TodayViewDto) => {
      today = view;
    },
    emitDataChange: () => {
      for (const notify of listeners) notify();
    },
    getToday: () => {
      calls.push("getToday");
      return Promise.resolve(today);
    },
    get dragStarts() {
      return dragStarts;
    },
    get calls() {
      return calls;
    },
    emitFloatingPointerLeft: () => {
      for (const notify of pointerLeftListeners) notify();
    },
    subscribeFloatingPointerLeft: (onLeft: () => void) => {
      pointerLeftListeners.add(onLeft);
      return () => {
        pointerLeftListeners.delete(onLeft);
      };
    },
    get lastExpand() {
      return lastExpand;
    },
    expandFloating: (width: number, height: number) => {
      calls.push("expandFloating");
      lastExpand = { width, height };
      return Promise.resolve({ horizontal: "right" as const, vertical: "top" as const });
    },
    collapseFloating: () => {
      calls.push("collapseFloating");
      return Promise.resolve();
    },
    startFloatingDrag: () => {
      calls.push("startFloatingDrag");
      dragStarts += 1;
      return Promise.resolve();
    },
    openMain: () => {
      calls.push("openMain");
      openMainCalls += 1;
      return Promise.resolve();
    },
    quitApp: () => Promise.resolve(),
    createItem: (request: CreateItemRequest) => {
      calls.push("createItem");
      if (pendingFailure !== undefined) {
        const failure = pendingFailure;
        pendingFailure = undefined;
        return Promise.reject(failure);
      }
      return insert(request);
    },
    getItem: (id: string) => {
      calls.push("getItem");
      const found = items.find((item) => item.id === id);
      return found === undefined
        ? Promise.reject(new AppError("ITEM_NOT_FOUND", `Item ${id} 不存在`))
        : Promise.resolve(found);
    },
    listItems: (request: ListItemsRequest) => {
      calls.push("listItems");
      const visible = items
        .filter((item) => request.includeArchived || item.archivedAt === null)
        .filter((item) => request.itemType === null || item.itemType === request.itemType)
        .reverse();
      return Promise.resolve(request.limit === null ? visible : visible.slice(0, request.limit));
    },
    subscribeDataChanges: (onChange: () => void) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}
