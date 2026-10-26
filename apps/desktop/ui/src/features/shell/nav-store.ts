import { create } from "zustand";

/** 主窗口里的视图。 */
export type MainView =
  | "inbox"
  | "today"
  | "calendar"
  | "notes"
  | "projects"
  | "workflows"
  | "trash"
  | "settings"
  | "dev";

/** 可以由悬浮窗、全局搜索框等外部请求直接打开的视图（与后端 `open_main_at` 一致）。 */
const OPENABLE_VIEWS: readonly MainView[] = [
  "inbox",
  "today",
  "calendar",
  "notes",
  "projects",
  "workflows",
  "trash",
  "settings",
];

/**
 * 把后端传来的视图名变成 [`MainView`]；不认识的返回 `null`。
 *
 * @param name 视图名。
 * @returns 视图，或 `null`。
 */
export function parseMainView(name: string): MainView | null {
  return OPENABLE_VIEWS.find((view) => view === name) ?? null;
}

/** 导航 Store 的状态与动作。 */
type NavState = {
  /** 当前显示的视图。 */
  view: MainView;
  /** 切换视图。 */
  setView: (view: MainView) => void;
};

/**
 * 主窗口的导航状态（只是 UI 本地状态，前端规范 §7）。
 *
 * 主窗口"关闭"只是隐藏，所以这个状态在窗口再次显示时仍然保留，用户回到离开前的位置。
 */
export const useNavStore = create<NavState>((set) => ({
  view: "today",
  setView: (view) => set({ view }),
}));
