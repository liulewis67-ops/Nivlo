import { AppError } from "@/lib/errors";
import type { CreateItemRequest, ItemDto, IpcClient, ListItemsRequest } from "@/lib/ipc";

/** 标题允许的最大字符数，与后端 `MAX_TITLE_CHARS` 保持一致。 */
const MAX_TITLE_CHARS = 500;

/** 内存版 IPC 额外暴露的、仅供测试使用的能力。 */
export interface MemoryIpc extends IpcClient {
  /** 当前保存的全部 Item（按创建顺序）。 */
  readonly items: readonly ItemDto[];
  /** `openMain` 被调用的次数。 */
  readonly openMainCalls: number;
  /** `startFloatingDrag` 被调用的次数。 */
  readonly dragStarts: number;
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
  let pendingFailure = options.failNextCreateWith;
  let openMainCalls = 0;
  let dragStarts = 0;

  return {
    get items() {
      return items;
    },
    get openMainCalls() {
      return openMainCalls;
    },
    get dragStarts() {
      return dragStarts;
    },
    startFloatingDrag: () => {
      dragStarts += 1;
      return Promise.resolve();
    },
    openMain: () => {
      openMainCalls += 1;
      return Promise.resolve();
    },
    quitApp: () => Promise.resolve(),
    createItem: (request: CreateItemRequest) => {
      if (pendingFailure !== undefined) {
        const failure = pendingFailure;
        pendingFailure = undefined;
        return Promise.reject(failure);
      }
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
    },
    getItem: (id: string) => {
      const found = items.find((item) => item.id === id);
      return found === undefined
        ? Promise.reject(new AppError("ITEM_NOT_FOUND", `Item ${id} 不存在`))
        : Promise.resolve(found);
    },
    listItems: (request: ListItemsRequest) => {
      const visible = items
        .filter((item) => request.includeArchived || item.archivedAt === null)
        .filter((item) => request.itemType === null || item.itemType === request.itemType)
        .reverse();
      return Promise.resolve(request.limit === null ? visible : visible.slice(0, request.limit));
    },
    subscribeItemChanges: (onChange: () => void) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}
