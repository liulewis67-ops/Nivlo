import { create } from "zustand";

/** Toast 的类别，决定样式与无障碍角色。 */
export type ToastKind = "info" | "success" | "error";

/** 一条 Toast。 */
export type ToastItem = {
  /** 唯一 ID。 */
  id: number;
  /** 类别。 */
  kind: ToastKind;
  /** 已翻译的展示文案。 */
  message: string;
};

/** 不指定时的自动消失时长（毫秒）。 */
export const DEFAULT_TOAST_DURATION_MS = 4000;

/** Toast Store 的状态与动作。 */
type ToastState = {
  /** 当前显示的 Toast。 */
  toasts: ToastItem[];
  /** 显示一条 Toast，并在 `durationMs` 后自动关闭；返回它的 ID。 */
  push: (kind: ToastKind, message: string, durationMs?: number) => number;
  /** 立即关闭一条 Toast。 */
  dismiss: (id: number) => void;
};

/** 自增 ID 计数器。 */
let nextId = 1;

/** 每条 Toast 对应的自动关闭 Timer，关闭时必须清除以免泄漏。 */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Toast 的 Zustand Store。
 *
 * 只保存可序列化的展示数据；错误到文案的转换由调用方完成。
 */
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message, durationMs = DEFAULT_TOAST_DURATION_MS) => {
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }));
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), durationMs),
    );
    return id;
  },
  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },
}));
