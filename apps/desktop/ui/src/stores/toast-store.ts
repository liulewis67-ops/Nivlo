import { create } from "zustand";

/** Toast 的类别，决定样式与无障碍角色。 */
export type ToastKind = "info" | "success" | "error";

/** Toast 上的一个操作按钮（如「撤销」）。 */
export type ToastAction = {
  /** 已翻译的按钮文案。 */
  label: string;
  /** 点击时调用；调用后 Toast 自动关闭。 */
  onClick: () => void;
  /** 这是「撤销」：主窗口里按 Ctrl+Z 会执行最新的一条撤销（`undoLatest`）。 */
  undo?: boolean;
};

/** 一条 Toast。 */
export type ToastItem = {
  /** 唯一 ID。 */
  id: number;
  /** 类别。 */
  kind: ToastKind;
  /** 已翻译的展示文案。 */
  message: string;
  /** 可选的操作按钮。 */
  action?: ToastAction;
  /** 额外的查看动作，不替代快捷键撤销。 */
  secondaryAction?: ToastAction;
};

/** 不指定时的自动消失时长（毫秒）。 */
export const DEFAULT_TOAST_DURATION_MS = 4000;

/** Toast Store 的状态与动作。 */
type ToastState = {
  /** 当前显示的 Toast。 */
  toasts: ToastItem[];
  /** 显示一条 Toast，并在 `durationMs` 后自动关闭；返回它的 ID。 */
  push: (
    kind: ToastKind,
    message: string,
    durationMs?: number,
    action?: ToastAction,
    secondaryAction?: ToastAction,
  ) => number;
  /** 立即关闭一条 Toast。 */
  dismiss: (id: number) => void;
  /** 执行最新一条还在显示的「撤销」并关闭它；没有可撤销的返回 `false`。 */
  undoLatest: () => boolean;
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
  push: (kind, message, durationMs = DEFAULT_TOAST_DURATION_MS, action, secondaryAction) => {
    const id = nextId++;
    const toast: ToastItem = {
      id,
      kind,
      message,
      ...(action === undefined ? {} : { action }),
      ...(secondaryAction === undefined ? {} : { secondaryAction }),
    };
    set((state) => ({ toasts: [...state.toasts, toast] }));
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
  undoLatest: () => {
    const undoable = get().toasts.filter((toast) => toast.action?.undo === true);
    const latest = undoable[undoable.length - 1];
    if (latest?.action === undefined) return false;
    get().dismiss(latest.id);
    latest.action.onClick();
    return true;
  },
}));
