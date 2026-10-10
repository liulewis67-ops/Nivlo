import { create } from "zustand";

/** 主窗口里的视图。 */
export type MainView = "inbox" | "today" | "calendar" | "notes" | "projects" | "dev";

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
