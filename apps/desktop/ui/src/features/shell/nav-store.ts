import { create } from "zustand";
import { useDraftTransitionStore } from "@/stores/draft-transition-store";

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
  /** 主内容区正在查看的事项；null 表示显示当前页面。 */
  detailId: string | null;
  /** 在主内容区打开详情，先检查当前草稿；null 返回原页面。 */
  openItem: (id: string | null) => void;
  /** 切换视图。 */
  setView: (view: MainView) => void;
  /** Notes 视图里打开的笔记；`null` 表示打开最近更新的那一篇。离开 Notes 再回来时仍是这一篇。 */
  noteId: string | null;
  /** 刚新建的笔记：打开时聚焦并全选标题；换到别的笔记后清空。 */
  freshNoteId: string | null;
  /** 切到 Notes 视图并打开一篇笔记；`fresh` 表示刚新建。 */
  openNote: (id: string, fresh?: boolean) => void;
  /** 设置页要滚到的分组（锚点 ID）；设置页滚过去后清空。 */
  settingsSection: string | null;
  /** 打开设置页并滚到某个分组（Ctrl+K 的「设置：…」命令）；`null` 表示清空。 */
  openSettings: (section: string | null) => void;
  /**
   * 离开当前视图前的检查（如自动化编辑区有没保存的修改）：返回 `true` 时切换先被拦下，
   * 记在 [`pendingNav`] 里，等用户确认放弃修改（[`confirmLeave`]）再执行。
   */
  leaveGuard: (() => boolean) | null;
  /** 注册 / 清除离开检查。 */
  setLeaveGuard: (guard: (() => boolean) | null) => void;
  /** 被拦下的那次切换；没有时为 `null`。 */
  pendingNav: (() => void) | null;
  /** 放弃修改，执行被拦下的切换。 */
  confirmLeave: () => void;
  /** 留在原处，丢掉被拦下的切换。 */
  cancelLeave: () => void;
};

/**
 * 主窗口的导航状态（只是 UI 本地状态，前端规范 §7）。
 *
 * 主窗口"关闭"只是隐藏，所以这个状态在窗口再次显示时仍然保留，用户回到离开前的位置。
 */
export const useNavStore = create<NavState>((set, get) => {
  /**
   * 换视图：离开检查说要拦下时先记着，等确认；否则立即执行。
   *
   * @param apply 真正的切换。
   */
  const navigate = (apply: () => void): void => {
    useDraftTransitionStore.getState().request(() => {
      if (get().leaveGuard?.() === true) {
        // 详情已经保存成功，关闭它后才能操作背后 Workflow 的既有离开提示。
        set({ pendingNav: apply, detailId: null });
        return;
      }
      apply();
    });
  };
  return {
    view: "today",
    detailId: null,
    openItem: (id) => {
      useDraftTransitionStore.getState().request(() => {
        set({ detailId: id });
      });
    },
    // 离开 Notes 后「刚新建」不再成立：回来时不再全选标题，免得打字覆盖已经写好的标题。
    setView: (view) => {
      /** 真正的切换。 */
      const apply = (): void =>
        set((state) => ({
          view,
          detailId: null,
          freshNoteId: view === "notes" ? state.freshNoteId : null,
        }));
      if (view === get().view && get().detailId === null) {
        useDraftTransitionStore.getState().cancel();
        set({ pendingNav: null });
        apply();
      } else navigate(apply);
    },
    leaveGuard: null,
    setLeaveGuard: (guard) => set({ leaveGuard: guard }),
    pendingNav: null,
    confirmLeave: () => {
      const pending = get().pendingNav;
      set({ pendingNav: null, leaveGuard: null });
      pending?.();
    },
    cancelLeave: () => set({ pendingNav: null }),
    noteId: null,
    freshNoteId: null,
    settingsSection: null,
    openSettings: (section) => {
      if (section === null) set({ settingsSection: null });
      else navigate(() => set({ view: "settings", detailId: null, settingsSection: section }));
    },
    openNote: (id, fresh = false) =>
      navigate(() =>
        set((state) => ({
          view: "notes",
          detailId: null,
          noteId: id,
          freshNoteId: fresh ? id : state.freshNoteId === id ? id : null,
        })),
      ),
  };
});
