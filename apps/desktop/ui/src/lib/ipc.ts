import { isTauri } from "@tauri-apps/api/core";
import { commands, events } from "@/bindings";
import type { CreateItemRequest, IpcError, ItemDto, ListItemsRequest } from "@/bindings";
import { toAppError } from "./errors";

export type {
  ContentFormatDto,
  CreateItemRequest,
  DatePointDto,
  ItemDto,
  ItemStatusDto,
  ItemTypeDto,
  ListItemsRequest,
  PriorityDto,
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
   * 订阅"Item 发生了变化"的后端事件（创建或更新）。
   *
   * @param onChange 事件到达时的回调；事件只携带 ID，调用方应当刷新相关缓存。
   * @returns 取消订阅的函数，组件卸载时必须调用。
   */
  subscribeItemChanges(onChange: () => void): () => void;
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
  openMain: async () => {
    await call("open_main", commands.openMain());
  },
  quitApp: () => commands.quitApp(),
  startFloatingDrag: async () => {
    await call("start_floating_drag", commands.startFloatingDrag());
  },
  subscribeItemChanges: (onChange) =>
    listenAll([
      () => events.itemCreated.listen(() => onChange()),
      () => events.itemUpdated.listen(() => onChange()),
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
  openMain: () => current.openMain(),
  quitApp: () => current.quitApp(),
  startFloatingDrag: () => current.startFloatingDrag(),
  subscribeItemChanges: (onChange) => current.subscribeItemChanges(onChange),
};
