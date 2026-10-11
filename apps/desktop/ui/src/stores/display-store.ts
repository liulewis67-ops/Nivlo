import { create } from "zustand";
import { ipc } from "@/lib/ipc";

/** 偏好在 localStorage 中的 key；悬浮窗与主窗口共用，靠 `storage` 事件同步。 */
export const HIDE_COMPLETED_STORAGE_KEY = "nivlo.hideCompleted";

/** 读取已保存的「隐藏已完成」；默认显示。 */
function load(): boolean {
  try {
    return window.localStorage.getItem(HIDE_COMPLETED_STORAGE_KEY) === "true";
  } catch {
    // localStorage 不可用：按默认（显示已完成）处理。
    return false;
  }
}

/** 把值写入本地缓存。 */
function cache(hide: boolean): void {
  try {
    window.localStorage.setItem(HIDE_COMPLETED_STORAGE_KEY, String(hide));
  } catch {
    // 缓存写入失败只影响下次启动的首帧。
  }
}

/** 显示偏好的状态与操作。 */
type DisplayState = {
  /** Today 是否隐藏今日已完成的 Todo（D-07）。 */
  hideCompleted: boolean;
  /** 修改并保存（本地缓存 + 后端 settings 表，随备份）。 */
  setHideCompleted: (hide: boolean) => void;
  /** 用后端保存的文本覆盖本地缓存；非法值忽略。 */
  hydrate: (value: string) => void;
  /** 接收其他窗口的修改（只应用，不回写）。 */
  adopt: (hide: boolean) => void;
};

/** Today 显示偏好的 Zustand Store。 */
export const useDisplayStore = create<DisplayState>((set) => ({
  hideCompleted: load(),
  setHideCompleted: (hide) => {
    cache(hide);
    set({ hideCompleted: hide });
    ipc.setUiPref("hideCompleted", String(hide)).catch(() => undefined);
  },
  hydrate: (value) => {
    if (value !== "true" && value !== "false") return;
    const hide = value === "true";
    cache(hide);
    set({ hideCompleted: hide });
  },
  adopt: (hide) => set({ hideCompleted: hide }),
}));

/** 监听其他窗口对显示偏好的修改。 */
export function initDisplay(): void {
  window.addEventListener("storage", (event) => {
    if (event.key !== HIDE_COMPLETED_STORAGE_KEY) return;
    useDisplayStore.getState().adopt(event.newValue === "true");
  });
}
