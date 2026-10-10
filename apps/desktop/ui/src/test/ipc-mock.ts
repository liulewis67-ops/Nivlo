import { AppError } from "@/lib/errors";
import type {
  AttachmentDto,
  PatchDto,
  UpdateItemRequest,
  ShortcutStatusDto,
  CaptureRequestDto,
  InboxEntryDto,
  OrganizeActionDto,
  PreviousStateDto,
  SourceDto,
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
  /** 按顺序记录的全部 `capture` 请求。 */
  readonly captures: readonly CaptureRequestDto[];
  /** 按顺序记录的全部 `undoCapture` 收到的 ID。 */
  readonly undoneCaptures: readonly string[][];
  /** 按顺序记录的全部 `organizeItems` 调用。 */
  readonly organizations: readonly { ids: string[]; action: OrganizeActionDto }[];
  /** 按顺序记录的全部 `restoreItems` 收到的状态。 */
  readonly restorations: readonly PreviousStateDto[][];
  /** 让下一次 `organizeItems` / `restoreItems` 抛出的错误；触发后自动清除。 */
  failNextOrganizeWith(error: AppError): void;
  /** 让下一次 `capture` 抛出的错误；触发后自动清除。 */
  failNextCaptureWith(error: AppError): void;
  /** 设置下一次及之后 `getToday` 返回的 Today 视图。 */
  setToday(view: TodayViewDto): void;
  /** 模拟后端发出一次数据变更事件（`item_created` / `day_changed` 等）。 */
  emitDataChange(): void;
  /** 按顺序记录的全部 `openMainAt` 请求的视图。 */
  readonly openedViews: readonly string[];
  /** 设置下一次 `takePendingMainView` 返回的视图（模拟主窗口启动时已有待处理请求）。 */
  setPendingMainView(view: string | null): void;
  /** 模拟已运行的主窗口收到「切换视图」事件。 */
  emitMainViewRequested(view: string): void;
  /** 按顺序记录的全部 `updateItem` 请求。 */
  readonly updates: readonly { id: string; request: UpdateItemRequest }[];
  /** 让下一次 `updateItem` 抛出的错误（模拟保存失败）；触发后自动清除。 */
  failNextUpdateWith(error: AppError): void;
  /** 按顺序记录的 `openItemSource` 请求的 ID。 */
  readonly openedSources: readonly string[];
  /** 让下一次 `openItemSource` 抛出的错误（如 `SOURCE_FILE_MISSING`）；触发后自动清除。 */
  failNextOpenSourceWith(error: AppError): void;
  /** 设置模拟剪贴板的内容；`null` 表示空剪贴板（`captureFromClipboard` 抛出 `CLIPBOARD_EMPTY`）。 */
  setClipboard(content: { text?: string; files?: string[] } | null): void;
  /** 设置全局快捷键的状态（模拟启动时被占用等）。 */
  setShortcutStatus(status: ShortcutStatusDto): void;
  /** 已被其他程序占用的快捷键（规范文本），`setQuickCreateShortcut` 遇到它们抛出 `SHORTCUT_CONFLICT`。 */
  readonly takenShortcuts: Set<string>;
  /** 模拟托盘「快速添加」。 */
  emitQuickAddRequested(): void;
  /** 模拟后端看门狗补发"指针已离开"事件。 */
  emitFloatingPointerLeft(): void;
  /** 最近一次 `expandFloating` 请求的尺寸。 */
  readonly lastExpand: { width: number; height: number } | null;
}

/** 由捕获请求推出来源与附件（与后端默认规则一致的形状）。 */
function describeProvenance(
  request: CaptureRequestDto,
  capturedAt: string,
): { sources: SourceDto[]; attachments: AttachmentDto[] } {
  const base = { sourceApp: request.sourceApplication, originalTitle: null, capturedAt };
  const input = request.input;
  if (input.kind === "text") {
    const isUrl = /^https?:\/\/\S+$/.test(input.text.trim());
    return {
      sources: [
        {
          ...base,
          sourceType: isUrl ? "web" : "text",
          sourceUrl: isUrl ? input.text.trim() : null,
          sourcePath: null,
        },
      ],
      attachments: [],
    };
  }
  if (input.kind === "files") {
    const path = input.paths[0] ?? "";
    const name = path.split(/[\\/]/).pop() ?? path;
    return {
      sources: [{ ...base, sourceType: "file", sourceUrl: null, sourcePath: path }],
      attachments: [{ kind: "reference", path, name, mime: null, sizeBytes: null, exists: true }],
    };
  }
  return {
    sources: [{ ...base, sourceType: "image", sourceUrl: null, sourcePath: null }],
    attachments: [
      {
        kind: "stored",
        path: "image.png",
        name: "图片",
        mime: "image/png",
        sizeBytes: 1,
        exists: true,
      },
    ],
  };
}

/** 把整理动作应用到一个 Item（对齐后端的 D-02 规则）。 */
function applyOrganize(item: ItemDto, action: OrganizeActionDto, today: string): ItemDto {
  const now = new Date().toISOString();
  switch (action.kind) {
    case "leaveInbox":
      return { ...item, inInbox: false, updatedAt: now };
    case "archive":
      return { ...item, inInbox: false, archivedAt: now, updatedAt: now };
    case "convertTo":
      return item.itemType === action.item_type
        ? item
        : { ...item, itemType: action.item_type, inInbox: false, updatedAt: now };
    case "schedule": {
      const target = action.target;
      const base = new Date(`${today}T00:00:00Z`);
      const shift = (days: number): string => {
        const next = new Date(base);
        next.setUTCDate(next.getUTCDate() + days);
        return next.toISOString().slice(0, 10);
      };
      const date =
        target.kind === "today"
          ? today
          : target.kind === "tomorrow"
            ? shift(1)
            : target.kind === "later"
              ? shift((8 - base.getUTCDay()) % 7 || 7)
              : target.date;
      return { ...item, scheduled: { date, time: null }, inInbox: false, updatedAt: now };
    }
  }
}

/** 应用三态修改：缺省 / 保持 → 原值；清除 → null；设置 → 新值。 */
function applyPatch<T>(patch: PatchDto<T> | undefined, current: T | null): T | null {
  if (patch === undefined || patch.kind === "keep") return current;
  return patch.kind === "clear" ? null : patch.value;
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
  const quickAddListeners = new Set<() => void>();
  const mainViewListeners = new Set<(view: string) => void>();
  const takenShortcuts = new Set<string>();
  const updates: { id: string; request: UpdateItemRequest }[] = [];
  const openedSources: string[] = [];
  let updateFailure: AppError | undefined;
  let openSourceFailure: AppError | undefined;
  let clipboard: { text?: string; files?: string[] } | null = null;
  let shortcut: ShortcutStatusDto = {
    accelerator: "Ctrl+Shift+Space",
    registered: true,
    conflict: false,
  };
  const openedViews: string[] = [];
  let pendingMainView: string | null = null;
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
  const captures: CaptureRequestDto[] = [];
  const undoneCaptures: string[][] = [];
  let captureFailure: AppError | undefined;
  let organizeFailure: AppError | undefined;
  const organizations: { ids: string[]; action: OrganizeActionDto }[] = [];
  const restorations: PreviousStateDto[][] = [];
  /** 捕获时记录的来源与附件，供 `listInbox` 返回。 */
  const provenance = new Map<string, { sources: SourceDto[]; attachments: AttachmentDto[] }>();
  let lastExpand: { width: number; height: number } | null = null;

  /**
   * 与后端一致：今天创建的 Todo 追加到 Today 末尾，Tip 进入提示；Note 不进 Today。
   * 这样纯浏览器预览（pnpm dev:ui）里创建的内容也会出现在 Today 中。
   */
  function addToToday(item: ItemDto): void {
    if (item.scheduled === null || item.scheduled.date !== today.date) return;
    const entry: TodayItemDto = {
      id: item.id,
      itemType: item.itemType,
      title: item.title,
      status: item.status,
      priority: item.priority,
      scheduled: item.scheduled,
      due: item.due,
      isOverdue: false,
    };
    if (item.itemType === "todo") {
      today = {
        ...today,
        remainingCount: today.remainingCount + 1,
        todos: [...today.todos, entry],
      };
    } else if (item.itemType === "tip") {
      today = { ...today, tips: [...today.tips, entry] };
    }
  }

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
      inInbox: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null,
    };
    items.push(item);
    addToToday(item);
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
      inInbox: false,
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

  const memory: MemoryIpc = {
    get organizations() {
      return organizations;
    },
    get restorations() {
      return restorations;
    },
    failNextOrganizeWith: (error: AppError) => {
      organizeFailure = error;
    },
    listInbox: () => {
      calls.push("listInbox");
      const entries: InboxEntryDto[] = items
        .filter((item) => item.inInbox && item.archivedAt === null)
        .reverse()
        .map((item) => ({
          item,
          sources: provenance.get(item.id)?.sources ?? [],
          attachments: provenance.get(item.id)?.attachments ?? [],
        }));
      return Promise.resolve(entries);
    },
    getInboxCount: () => {
      calls.push("getInboxCount");
      return Promise.resolve(items.filter((i) => i.inInbox && i.archivedAt === null).length);
    },
    organizeItems: (ids: string[], action: OrganizeActionDto) => {
      calls.push("organizeItems");
      organizations.push({ ids, action });
      if (organizeFailure !== undefined) {
        const failure = organizeFailure;
        organizeFailure = undefined;
        return Promise.reject(failure);
      }
      const previous: PreviousStateDto[] = [];
      const updated: ItemDto[] = [];
      for (const id of ids) {
        const at = items.findIndex((item) => item.id === id);
        const current = items[at];
        if (current === undefined) {
          return Promise.reject(new AppError("ITEM_NOT_FOUND", `Item ${id} 不存在`));
        }
        previous.push({
          id,
          itemType: current.itemType,
          scheduled: current.scheduled,
          inInbox: current.inInbox,
          archived: current.archivedAt !== null,
        });
        const next = applyOrganize(current, action, today.date);
        items[at] = next;
        updated.push(next);
      }
      for (const notify of listeners) notify();
      return Promise.resolve({ items: updated, previous });
    },
    restoreItems: (previous: PreviousStateDto[]) => {
      calls.push("restoreItems");
      restorations.push(previous);
      if (organizeFailure !== undefined) {
        const failure = organizeFailure;
        organizeFailure = undefined;
        return Promise.reject(failure);
      }
      const restored: ItemDto[] = [];
      for (const state of previous) {
        const at = items.findIndex((item) => item.id === state.id);
        const current = items[at];
        if (current === undefined) continue;
        const next: ItemDto = {
          ...current,
          itemType: state.itemType,
          scheduled: state.scheduled,
          inInbox: state.inInbox,
          archivedAt: state.archived ? (current.archivedAt ?? current.updatedAt) : null,
        };
        items[at] = next;
        restored.push(next);
      }
      for (const notify of listeners) notify();
      return Promise.resolve(restored);
    },
    get captures() {
      return captures;
    },
    get undoneCaptures() {
      return undoneCaptures;
    },
    failNextCaptureWith: (error: AppError) => {
      captureFailure = error;
    },
    capture: async (request: CaptureRequestDto) => {
      calls.push("capture");
      captures.push(request);
      if (captureFailure !== undefined) {
        const failure = captureFailure;
        captureFailure = undefined;
        throw failure;
      }
      // 与后端默认规则一致：文本 → Todo，其余 → Note；全部进入 Inbox，没有计划日期。
      const input = request.input;
      const isPlainText = input.kind === "text" && !/^https?:\/\/\S+$/.test(input.text.trim());
      const title =
        input.kind === "text"
          ? (input.text.trim().split(/\r?\n/)[0] ?? "")
          : input.kind === "files"
            ? (input.paths[0]?.split(/[\\/]/).pop() ?? "")
            : "图片";
      const created = await insert({
        itemType: isPlainText ? "todo" : "note",
        title,
        content: null,
        contentFormat: null,
        priority: null,
        scheduled: null,
        due: null,
        reminderAt: null,
        projectId: null,
      });
      const item = { ...created, inInbox: true };
      items[items.length - 1] = item;
      provenance.set(item.id, describeProvenance(request, item.createdAt));
      // 与后端一致：事件在记录完整落库之后才发出，列表重取时能看到 Inbox 标记与来源。
      for (const notify of listeners) notify();
      return { items: [item], undoIds: [item.id] };
    },
    undoCapture: (itemIds: string[]) => {
      calls.push("undoCapture");
      undoneCaptures.push(itemIds);
      for (const id of itemIds) {
        const at = items.findIndex((item) => item.id === id);
        if (at >= 0) items.splice(at, 1);
      }
      for (const notify of listeners) notify();
      return Promise.resolve();
    },
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
    emitQuickAddRequested: () => {
      for (const notify of quickAddListeners) notify();
    },
    subscribeQuickAddRequested: (onRequested: () => void) => {
      quickAddListeners.add(onRequested);
      return () => {
        quickAddListeners.delete(onRequested);
      };
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
    takenShortcuts,
    get updates() {
      return updates;
    },
    get openedSources() {
      return openedSources;
    },
    failNextUpdateWith: (error: AppError) => {
      updateFailure = error;
    },
    failNextOpenSourceWith: (error: AppError) => {
      openSourceFailure = error;
    },
    getItemDetail: (id: string) => {
      calls.push("getItemDetail");
      const item = items.find((candidate) => candidate.id === id);
      if (item === undefined) {
        return Promise.reject(new AppError("ITEM_NOT_FOUND", `Item ${id} 不存在`));
      }
      return Promise.resolve({
        item,
        sources: provenance.get(id)?.sources ?? [],
        attachments: provenance.get(id)?.attachments ?? [],
      });
    },
    updateItem: (id: string, request: UpdateItemRequest) => {
      calls.push("updateItem");
      updates.push({ id, request });
      if (updateFailure !== undefined) {
        const failure = updateFailure;
        updateFailure = undefined;
        return Promise.reject(failure);
      }
      const at = items.findIndex((candidate) => candidate.id === id);
      const current = items[at];
      if (current === undefined) {
        return Promise.reject(new AppError("ITEM_NOT_FOUND", `Item ${id} 不存在`));
      }
      if (request.title !== undefined && request.title !== null && request.title.trim() === "") {
        return Promise.reject(new AppError("ITEM_TITLE_EMPTY", "标题为空"));
      }
      const changed = request.itemType !== undefined && request.itemType !== null;
      const next: ItemDto = {
        ...current,
        ...(changed ? { itemType: request.itemType ?? current.itemType, inInbox: false } : {}),
        ...(request.title === undefined || request.title === null
          ? {}
          : { title: request.title.trim() }),
        ...(request.contentFormat === undefined || request.contentFormat === null
          ? {}
          : { contentFormat: request.contentFormat }),
        ...(request.priority === undefined || request.priority === null
          ? {}
          : { priority: request.priority }),
        content: applyPatch(request.content, current.content),
        scheduled: applyPatch(request.scheduled, current.scheduled),
        due: applyPatch(request.due, current.due),
        updatedAt: new Date().toISOString(),
      };
      items[at] = next;
      for (const notify of listeners) notify();
      return Promise.resolve(next);
    },
    openItemSource: (id: string) => {
      calls.push("openItemSource");
      openedSources.push(id);
      if (openSourceFailure !== undefined) {
        const failure = openSourceFailure;
        openSourceFailure = undefined;
        return Promise.reject(failure);
      }
      return Promise.resolve();
    },
    setClipboard: (content: { text?: string; files?: string[] } | null) => {
      clipboard = content;
    },
    captureFromClipboard: () => {
      calls.push("captureFromClipboard");
      const files = clipboard?.files ?? [];
      const text = clipboard?.text ?? "";
      if (files.length === 0 && text.trim() === "") {
        return Promise.reject(new AppError("CLIPBOARD_EMPTY", "剪贴板为空"));
      }
      return memory.capture(
        files.length > 0
          ? { input: { kind: "files", paths: files }, origin: "paste", sourceApplication: null }
          : { input: { kind: "text", text }, origin: "paste", sourceApplication: null },
      );
    },
    setShortcutStatus: (status: ShortcutStatusDto) => {
      shortcut = status;
    },
    getShortcutStatus: () => {
      calls.push("getShortcutStatus");
      return Promise.resolve(shortcut);
    },
    setQuickCreateShortcut: (accelerator: string) => {
      calls.push("setQuickCreateShortcut");
      if (!/^(Ctrl|Alt|Shift|Win)(\+(Ctrl|Alt|Shift|Win))*\+[A-Za-z0-9]+$/.test(accelerator)) {
        return Promise.reject(new AppError("SHORTCUT_INVALID", "无效的快捷键"));
      }
      if (takenShortcuts.has(accelerator)) {
        return Promise.reject(new AppError("SHORTCUT_CONFLICT", "已被占用"));
      }
      shortcut = { accelerator, registered: true, conflict: false };
      return Promise.resolve(shortcut);
    },
    get openedViews() {
      return openedViews;
    },
    setPendingMainView: (view: string | null) => {
      pendingMainView = view;
    },
    emitMainViewRequested: (view: string) => {
      for (const notify of mainViewListeners) notify(view);
    },
    openMainAt: (view: string) => {
      calls.push("openMainAt");
      openedViews.push(view);
      openMainCalls += 1;
      return Promise.resolve();
    },
    takePendingMainView: () => {
      calls.push("takePendingMainView");
      const view = pendingMainView;
      pendingMainView = null;
      return Promise.resolve(view);
    },
    subscribeMainViewRequested: (onRequested: (view: string) => void) => {
      mainViewListeners.add(onRequested);
      return () => {
        mainViewListeners.delete(onRequested);
      };
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
  return memory;
}
