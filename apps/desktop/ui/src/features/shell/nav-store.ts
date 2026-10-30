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
  /** Notes 视图里打开的笔记；`null` 表示打开最近更新的那一篇。离开 Notes 再回来时仍是这一篇。 */
  noteId: string | null;
  /** 刚新建的笔记：打开时聚焦并全选标题；换到别的笔记后清空。 */
  freshNoteId: string | null;
  /** 切到 Notes 视图并打开一篇笔记；`fresh` 表示刚新建。 */
  openNote: (id: string, fresh?: boolean) => void;
};

/**
 * 主窗口的导航状态（只是 UI 本地状态，前端规范 §7）。
 *
 * 主窗口"关闭"只是隐藏，所以这个状态在窗口再次显示时仍然保留，用户回到离开前的位置。
 */
export const useNavStore = create<NavState>((set) => ({
  view: "today",
  // 离开 Notes 后「刚新建」不再成立：回来时不再全选标题，免得打字覆盖已经写好的标题。
  setView: (view) =>
    set((state) => ({ view, freshNoteId: view === "notes" ? state.freshNoteId : null })),
  noteId: null,
  freshNoteId: null,
  openNote: (id, fresh = false) =>
    set((state) => ({
      view: "notes",
      noteId: id,
      freshNoteId: fresh ? id : state.freshNoteId === id ? id : null,
    })),
}));
