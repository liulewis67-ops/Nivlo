import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { CalendarPage } from "@/features/calendar";
import { DevConsole } from "@/features/dev-console";
import { ItemDetailPanel, OpenItemContext } from "@/features/detail";
import { InboxPage, useInboxCountQuery } from "@/features/inbox";
import { NotesPage } from "@/features/notes";
import { OnboardingDialog } from "@/features/onboarding";
import { ProjectsPage } from "@/features/projects";
import { CommandPalette } from "@/features/search";
import { SettingsPage } from "@/features/settings";
import { ShortcutSetting } from "@/features/shortcut";
import { TodayPage, useTodayQuery } from "@/features/today";
import { TrashPage } from "@/features/trash";
import { cx } from "@/lib/cx";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { NavIcon } from "./NavIcons";
import { parseMainView, useNavStore } from "./nav-store";
import type { MainView } from "./nav-store";
import { ThemeMenu } from "./ThemeMenu";

/** 侧栏导航项，按展示顺序排列（产品文档 §23）。 */
const NAV_VIEWS: MainView[] = ["inbox", "today", "calendar", "notes", "projects"];

/** 开发模式额外显示的视图：Phase 0 的 IPC 演示页，发布版本不出现。 */
const DEV_VIEWS: MainView[] = import.meta.env.DEV ? ["dev"] : [];

/** [`NavButton`] 的 Props。 */
type NavButtonProps = {
  /** 这个按钮对应的视图。 */
  view: MainView;
  /** 当前是否被选中。 */
  isActive: boolean;
  /** 角标数字（如 Today 剩余待办数）；为 `null` 时不显示。 */
  count: number | null;
  /** 点击回调。 */
  onSelect: () => void;
};

/**
 * 侧栏里的一个导航按钮。
 *
 * @param props 视图、选中状态与角标。
 * @returns 导航按钮。
 */
function NavButton({ view, isActive, count, onSelect }: NavButtonProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-current={isActive ? "page" : undefined}
      onClick={onSelect}
      className={cx(
        "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        isActive
          ? "bg-primary font-medium text-primary-contrast"
          : "text-text hover:bg-surface-hover",
      )}
    >
      <NavIcon view={view} />
      <span className="flex-1 text-left">{t(`shell.nav.${view}`)}</span>
      {count !== null && count > 0 && (
        <span
          className={cx(
            "min-w-5 rounded-full px-1.5 text-center text-xs tabular-nums",
            isActive ? "bg-primary-contrast/20" : "bg-surface-hover text-muted",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/**
 * 主窗口外壳：左侧导航 + 右侧当前视图（实施计划 1.10、产品文档 §23）。
 *
 * 各视图都是完整实现。
 * Today 的角标取自 Today 查询缓存，和悬浮窗徽标是同一个数字；Inbox 的角标是等待整理的条数。
 *
 * @returns 主窗口内容。
 */
export function MainShell() {
  const { t } = useTranslation();
  const view = useNavStore((state) => state.view);
  const setView = useNavStore((state) => state.setView);
  const remaining = useTodayQuery().data?.remainingCount ?? null;
  const inboxCount = useInboxCountQuery().data ?? null;
  /** 详情面板里正在编辑的条目；`null` 表示面板关闭。 */
  const [openId, setOpenId] = useState<string | null>(null);
  /** 搜索面板（Ctrl+K）是否打开。 */
  const [searching, setSearching] = useState(false);
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: queryKeys.appSettings(),
    queryFn: () => ipc.getAppSettings(),
    staleTime: Infinity,
  });

  // Ctrl+K（macOS 上 ⌘K）打开 / 关闭搜索面板。
  useEffect(() => {
    /**
     * 全局快捷键：窗口里任何位置都生效，包括输入框。
     *
     * @param event 键盘事件。
     */
    function handleKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching((open) => !open);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 悬浮窗请求打开某个视图：窗口刚创建时从后端取走待处理的请求，已经在运行时由事件通知。
  useEffect(() => {
    let cancelled = false;
    void ipc.takePendingMainView().then((name) => {
      const requested = name === null ? null : parseMainView(name);
      if (!cancelled && requested !== null) setView(requested);
    });
    const unsubscribe = ipc.subscribeMainViewRequested((name) => {
      const requested = parseMainView(name);
      if (requested !== null) setView(requested);
      void ipc.takePendingMainView();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setView]);

  return (
    <OpenItemContext.Provider value={setOpenId}>
      <div className="grid h-full grid-cols-[13.5rem_1fr_auto] bg-bg">
        <aside className="flex min-h-0 flex-col gap-4 border-r border-border bg-surface px-3 py-4">
          <div className="flex items-center gap-2 px-2">
            <span aria-hidden="true" className="size-2.5 rounded-full bg-primary" />
            <span className="text-lg font-semibold tracking-wide text-text">{t("app.name")}</span>
          </div>
          <button
            type="button"
            onClick={() => setSearching(true)}
            className="flex h-9 w-full items-center gap-2.5 rounded-md border border-border bg-bg px-2.5 text-sm text-muted transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard) hover:border-primary hover:text-text"
          >
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="size-4 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
            <span className="flex-1 text-left">{t("search.open")}</span>
            <kbd className="rounded border border-border px-1.5 text-[11px]">{"Ctrl K"}</kbd>
          </button>
          <nav aria-label={t("shell.nav.label")} className="flex flex-col gap-1">
            {[...NAV_VIEWS, ...DEV_VIEWS].map((item) => (
              <NavButton
                key={item}
                view={item}
                isActive={view === item}
                count={item === "today" ? remaining : item === "inbox" ? inboxCount : null}
                onSelect={() => setView(item)}
              />
            ))}
          </nav>
          <div className="mt-auto flex flex-col gap-1">
            <NavButton
              view="trash"
              isActive={view === "trash"}
              count={null}
              onSelect={() => setView("trash")}
            />
            <NavButton
              view="settings"
              isActive={view === "settings"}
              count={null}
              onSelect={() => setView("settings")}
            />
            <ShortcutSetting />
            <ThemeMenu />
          </div>
        </aside>
        <main className="min-h-0 min-w-0 overflow-hidden">
          {view === "inbox" && <InboxPage />}
          {view === "notes" && <NotesPage />}
          {view === "today" && <TodayPage />}
          {view === "dev" && (
            <div className="h-full overflow-y-auto">
              <DevConsole />
            </div>
          )}
          {view === "projects" && <ProjectsPage />}
          {view === "trash" && <TrashPage />}
          {view === "settings" && <SettingsPage />}
          {view === "calendar" && <CalendarPage />}
        </main>
        {settings.data?.onboardingCompleted === false && (
          <OnboardingDialog
            onFinish={() => {
              // 先在界面上收起，再保存；保存失败也不会再次弹出打扰（下次启动才会重试）。
              queryClient.setQueryData(queryKeys.appSettings(), {
                ...settings.data,
                onboardingCompleted: true,
              });
              ipc.setOnboardingCompleted(true).catch(reportError);
            }}
          />
        )}
        {searching && <CommandPalette onClose={() => setSearching(false)} onOpenItem={setOpenId} />}
        {openId !== null && (
          <ItemDetailPanel key={openId} id={openId} onClose={() => setOpenId(null)} />
        )}
      </div>
    </OpenItemContext.Provider>
  );
}
