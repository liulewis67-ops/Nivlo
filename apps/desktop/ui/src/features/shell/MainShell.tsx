import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { ipc } from "@/lib/ipc";
import { isCommandKey, isDialogOpen, isTyping } from "@/lib/typing";
import { CalendarPage } from "@/features/calendar";
import { DevConsole } from "@/features/dev-console";
import { ItemDetailPanel, OpenItemContext } from "@/features/detail";
import { InboxPage, useInboxCountQuery } from "@/features/inbox";
import { NotesPage } from "@/features/notes";
import { OnboardingDialog } from "@/features/onboarding";
import { useUpdateCheckOnStart, SETTINGS_SECTIONS } from "@/features/settings";
import { ProjectsPage } from "@/features/projects";
import { CreateItemDialog } from "@/features/quick-create";
import { CommandPalette, GOTO_VIEWS } from "@/features/search";
import type { PaletteCommand } from "@/features/search";
import { SettingsPage } from "@/features/settings";
import { ShortcutSetting, useShortcutQuery } from "@/features/shortcut";
import { TodayPage, useTodayQuery } from "@/features/today";
import { TrashPage } from "@/features/trash";
import { WorkflowsPage } from "@/features/workflows";
import { cx } from "@/lib/cx";
import { LAYOUT, useContainerWidth } from "@/lib/layout";
import { trapTab } from "@/lib/focus-trap";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useDisplayStore } from "@/stores/display-store";
import { resolveTheme, useThemeStore } from "@/stores/theme-store";
import { useToastStore } from "@/stores/toast-store";
import { NavIcon } from "./NavIcons";
import { parseMainView, useNavStore } from "./nav-store";
import type { MainView } from "./nav-store";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { ThemeMenu } from "./ThemeMenu";

/** 后端请求打开某个 Item 时的名字前缀：`item:<ID>`（点击通知，实施计划 10.6）。 */
const ITEM_REQUEST_PREFIX = "item:";

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
  /** 切到这个视图的快捷键（如 `Control+2`），供读屏读出；没有时省略。 */
  shortcut?: string | undefined;
};

/**
 * 侧栏里的一个导航按钮。
 *
 * @param props 视图、选中状态与角标。
 * @returns 导航按钮。
 */
function NavButton({ view, isActive, count, onSelect, shortcut }: NavButtonProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-current={isActive ? "page" : undefined}
      aria-keyshortcuts={shortcut}
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
            isActive ? "bg-primary-contrast text-primary" : "bg-surface-hover text-muted",
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
  const openNote = useNavStore((state) => state.openNote);
  const openSettings = useNavStore((state) => state.openSettings);
  const today = useTodayQuery().data;
  const remaining = today?.remainingCount ?? null;
  const inboxCount = useInboxCountQuery().data ?? null;
  /** 详情面板里正在编辑的条目；`null` 表示面板关闭。 */
  const openId = useNavStore((state) => state.detailId);
  const setOpenId = useNavStore((state) => state.openItem);
  /** 搜索面板（Ctrl+K）是否打开。 */
  const [searching, setSearching] = useState(false);
  /** 键盘快捷键一览是否打开。 */
  const [showingShortcuts, setShowingShortcuts] = useState(false);
  const [createOpener, setCreateOpener] = useState<HTMLButtonElement | null>(null);
  const settings = useQuery({
    queryKey: queryKeys.appSettings(),
    queryFn: () => ipc.getAppSettings(),
    staleTime: Infinity,
  });
  const onboarding = settings.data?.onboardingCompleted === false;
  const shellRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const navTriggerRef = useRef<HTMLButtonElement>(null);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const width = useContainerWidth(shellRef);
  const compact = width < LAYOUT.compactShell;
  const detailSheet = openId !== null && width < LAYOUT.dockedDetail;
  const detailModal = detailSheet && !searching && !showingShortcuts && !onboarding;
  const navModal =
    compact && navigationOpen && !detailModal && !searching && !showingShortcuts && !onboarding;
  /** 选择当前页面也要退出导航抽屉，避免把本页留在遮罩后。 */
  function selectView(target: MainView): void {
    setView(target);
    if (compact && navigationOpen && target === view) {
      setNavigationOpen(false);
      navTriggerRef.current?.focus();
    }
  }

  // 抽屉在导航成功后关闭；被保存失败拦下时，当前编辑器仍可恢复。
  useEffect(
    () =>
      useNavStore.subscribe((next, previous) => {
        if (next.view !== previous.view || next.detailId !== previous.detailId)
          setNavigationOpen(false);
      }),
    [],
  );
  useEffect(() => {
    if (navModal) navRef.current?.focus();
  }, [navModal]);
  useUpdateCheckOnStart();
  const queryClient = useQueryClient();

  const notificationsPaused = settings.data?.notificationsPaused ?? false;
  const searchShortcut = useShortcutQuery("search").data;
  const themePreference = useThemeStore((state) => state.preference);
  /** 「切换主题」切到与当前显示相反的那一个（跟随系统时以系统此刻的明暗为准）。 */
  const nextTheme = resolveTheme(themePreference) === "dark" ? "light" : "dark";
  const hideCompleted = useDisplayStore((state) => state.hideCompleted);
  /**
   * Ctrl+K 的命令（输入 `>`）：前往各视图，以及常用的动作——新建笔记（建好直接打开详情），
   * 暂停 / 恢复通知（与设置页、托盘是同一个开关，名称随当前状态变化）。
   */
  const paletteCommands: PaletteCommand[] = [
    ...GOTO_VIEWS.map((target) => ({
      id: `goto-${target}`,
      label: t("search.goto", { view: t(`shell.nav.${target}`) }),
      keywords: [target],
      run: () => setView(target),
    })),
    {
      id: "toggle-theme",
      label: t("search.switchTheme", { theme: t(`theme.${nextTheme}`) }),
      keywords: ["theme", "dark", "light"],
      run: () => useThemeStore.getState().setPreference(nextTheme),
    },
    {
      id: "toggle-completed",
      label: t(hideCompleted ? "search.showCompleted" : "search.hideCompleted"),
      keywords: ["completed", "done", "hide", "show"],
      // 与设置页的开关是同一个偏好（悬浮窗同步）。
      run: () => useDisplayStore.getState().setHideCompleted(!hideCompleted),
    },
    {
      id: "export-diagnostics",
      label: t("settings.diagnostics.label"),
      keywords: ["diagnostics", "logs", "bug", "report"],
      // 和设置页「导出诊断信息」同一个动作：遇到问题时最需要找到它。
      run: () => {
        ipc
          .exportDiagnostics()
          .then((path) =>
            useToastStore.getState().push("success", t("settings.diagnostics.done", { path })),
          )
          .catch(reportError);
      },
    },
    {
      id: "shortcuts",
      label: t("shortcuts.title"),
      keywords: ["shortcuts", "keyboard", "help", "?"],
      run: () => setShowingShortcuts(true),
    },
    {
      id: "new-note",
      label: t("search.newNote"),
      keywords: ["note", "new"],
      run: () => {
        ipc
          .createItem({
            itemType: "note",
            title: t("notes.untitled"),
            content: null,
            contentFormat: "markdown",
            priority: null,
            scheduled: null,
            due: null,
            reminderAt: null,
            projectId: null,
          })
          .then((note) => openNote(note.id, true))
          .catch(reportError);
      },
    },
    // 设置还没读到时不知道当前状态，先不列出开关。
    ...(settings.data === undefined
      ? []
      : [
          {
            id: "toggle-notifications",
            label: t(
              notificationsPaused ? "search.resumeNotifications" : "search.pauseNotifications",
            ),
            keywords: ["notifications", "pause", "resume"],
            run: () => {
              const paused = !notificationsPaused;
              ipc
                .setNotificationsPaused(paused)
                .then(() => {
                  queryClient.setQueryData<typeof settings.data>(
                    queryKeys.appSettings(),
                    (current) => current && { ...current, notificationsPaused: paused },
                  );
                  useToastStore
                    .getState()
                    .push(
                      "success",
                      t(paused ? "search.notificationsPaused" : "search.notificationsResumed"),
                    );
                })
                .catch(reportError);
            },
          },
        ]),
    // 「设置：快捷键」等：直接打开设置页的某一组；排在最后，免得「快捷键」先命中设置分组而不是快捷键一览。
    ...SETTINGS_SECTIONS.map(([section, key]) => ({
      id: `goto-${section}`,
      label: t("search.settingsGroup", { group: t(key) }),
      keywords: ["settings", section.replace("settings-", "")],
      run: () => openSettings(section),
    })),
  ];

  // Ctrl+K（macOS 上 ⌘K）打开 / 关闭搜索面板；Ctrl+1…5 切到侧栏上方的各个视图，Ctrl+, 打开设置。
  useEffect(() => {
    /**
     * 全局快捷键：窗口里任何位置都生效，包括输入框。
     *
     * @param event 键盘事件。
     */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing || onboarding || createOpener !== null)
        return;
      const command = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
      const position = Number.parseInt(event.key, 10);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowingShortcuts(false);
        setSearching((open) => !open);
      } else if (command && position >= 1 && position <= NAV_VIEWS.length) {
        event.preventDefault();
        setView(NAV_VIEWS[position - 1] as MainView);
      } else if (command && event.key === ",") {
        event.preventDefault();
        setView("settings");
      } else if (
        isCommandKey(event, "z") &&
        !isTyping(event) &&
        !isDialogOpen() &&
        useToastStore.getState().undoLatest()
      ) {
        // Ctrl+Z 撤销刚才的整理 / 完成 / 删除（和点提示上的「撤销」一样）；在输入框里仍是撤销输入。
        event.preventDefault();
      } else if (
        event.key === "?" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !isTyping(event)
      ) {
        // 「?」打开快捷键一览（常见的约定）；正在输入时它只是一个问号。
        event.preventDefault();
        setSearching(false);
        setShowingShortcuts(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setView, onboarding, createOpener]);

  // 悬浮窗请求打开某个视图：窗口刚创建时从后端取走待处理的请求，已经在运行时由事件通知。
  useEffect(() => {
    let cancelled = false;
    /** 处理后端请求：普通视图名切换视图，`item:<ID>`（点击通知）打开对应的 Item 详情。 */
    const apply = (name: string): void => {
      if (name.startsWith(ITEM_REQUEST_PREFIX)) {
        setOpenId(name.slice(ITEM_REQUEST_PREFIX.length));
        return;
      }
      const requested = parseMainView(name);
      if (requested !== null) setView(requested);
    };
    void ipc.takePendingMainView().then((name) => {
      if (!cancelled && name !== null) apply(name);
    });
    const unsubscribe = ipc.subscribeMainViewRequested((name) => {
      apply(name);
      void ipc.takePendingMainView();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setView, setOpenId]);

  const createButton = (
    <Button
      variant="primary"
      aria-haspopup="dialog"
      onClick={(event) => setCreateOpener(event.currentTarget)}
      className={compact ? "ml-auto" : "w-full justify-start"}
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
        <path d="M8 3v10M3 8h10" />
      </svg>
      {t("createConfiguration.title")}
    </Button>
  );

  return (
    <OpenItemContext.Provider value={setOpenId}>
      <div
        ref={shellRef}
        className={cx(
          "grid h-full grid-rows-[auto_minmax(0,1fr)] bg-bg",
          compact
            ? "grid-cols-[minmax(0,1fr)]"
            : "grid-cols-[var(--nv-sidebar-width)_minmax(0,1fr)_auto]",
        )}
      >
        <header
          hidden={!compact}
          inert={detailModal || navModal || searching || showingShortcuts || onboarding}
          className={cx(
            "col-span-full items-center gap-3 border-b border-border bg-surface px-3 py-2",
            compact ? "flex" : "hidden",
          )}
        >
          <button
            ref={navTriggerRef}
            type="button"
            aria-expanded={navModal}
            aria-controls="main-navigation"
            onClick={() => setNavigationOpen(true)}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            {t("shell.navigation")}
          </button>
          <span className="min-w-0 truncate text-sm font-medium">{t(`shell.nav.${view}`)}</span>
          {compact && createButton}
        </header>
        {navModal && (
          <div
            aria-hidden="true"
            className="fixed inset-0 z-(--nv-z-menu) bg-text/30"
            onMouseDown={() => {
              setNavigationOpen(false);
              navTriggerRef.current?.focus();
            }}
          />
        )}
        <aside
          id="main-navigation"
          hidden={compact && !navModal}
          ref={navRef}
          tabIndex={-1}
          role={navModal ? "dialog" : undefined}
          aria-modal={navModal ? true : undefined}
          aria-label={navModal ? t("shell.navigation") : undefined}
          inert={detailModal || searching || showingShortcuts || onboarding}
          onKeyDown={(event) => {
            if (!navModal || event.defaultPrevented) return;
            if (event.key === "Escape") {
              event.stopPropagation();
              setNavigationOpen(false);
              navTriggerRef.current?.focus();
            } else trapTab(event, navRef.current);
          }}
          className={cx(
            "row-start-2 min-h-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface px-3 py-4",
            compact
              ? navModal
                ? "fixed inset-y-0 left-0 z-(--nv-z-dialog) flex w-(--nv-sidebar-width) shadow-lg"
                : "hidden"
              : "flex",
          )}
        >
          <div className="flex items-center gap-2 px-2">
            <span aria-hidden="true" className="size-2.5 rounded-full bg-primary" />
            <span className="text-lg font-semibold tracking-wide text-text">{t("app.name")}</span>
          </div>
          {!compact && createButton}
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
            <kbd className="rounded border border-border px-1.5 text-xs">{"Ctrl K"}</kbd>
          </button>
          <nav aria-label={t("shell.nav.label")} className="flex flex-col gap-1">
            {[...NAV_VIEWS, ...DEV_VIEWS].map((item, index) => (
              <NavButton
                key={item}
                view={item}
                shortcut={index < NAV_VIEWS.length ? `Control+${index + 1}` : undefined}
                isActive={view === item}
                count={item === "today" ? remaining : item === "inbox" ? inboxCount : null}
                onSelect={() => selectView(item)}
              />
            ))}
          </nav>
          <div className="mt-auto flex flex-col gap-1">
            <NavButton
              view="workflows"
              isActive={view === "workflows"}
              count={null}
              onSelect={() => selectView("workflows")}
            />
            <NavButton
              view="trash"
              isActive={view === "trash"}
              count={null}
              onSelect={() => selectView("trash")}
            />
            <NavButton
              view="settings"
              shortcut="Control+,"
              isActive={view === "settings"}
              count={null}
              onSelect={() => selectView("settings")}
            />
            <ShortcutSetting action="quickCreate" />
            {/* 全局搜索的快捷键被占用时才出现（自动展开提示与修改框），否则只有设置页里看得到。 */}
            {searchShortcut?.conflict === true && <ShortcutSetting action="search" />}
            <ThemeMenu />
          </div>
        </aside>
        <main
          inert={detailModal || navModal || searching || showingShortcuts || onboarding}
          className="row-start-2 min-h-0 min-w-0 overflow-hidden"
        >
          {view === "inbox" && <InboxPage />}
          {view === "notes" && <NotesPage />}
          {view === "today" && <TodayPage />}
          {view === "dev" && (
            <div className="h-full overflow-y-auto">
              <DevConsole />
            </div>
          )}
          {view === "projects" && <ProjectsPage />}
          {view === "workflows" && <WorkflowsPage />}
          {view === "trash" && <TrashPage />}
          {view === "settings" && <SettingsPage />}
          {view === "calendar" && <CalendarPage />}
        </main>
        {onboarding && (
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
        {searching && !onboarding && (
          <CommandPalette
            onClose={() => setSearching(false)}
            onOpenItem={setOpenId}
            commands={paletteCommands}
          />
        )}
        {showingShortcuts && !onboarding && (
          <ShortcutsDialog onClose={() => setShowingShortcuts(false)} />
        )}
        {createOpener !== null && (
          <CreateItemDialog
            label={t("createConfiguration.title")}
            opener={createOpener}
            kind="todo"
            today={today?.date}
            onDone={() => setCreateOpener(null)}
            onCreated={(item) =>
              useToastStore
                .getState()
                .push("success", t("capture.created", { title: item.title }), undefined, {
                  label: t("capture.view"),
                  onClick: () =>
                    item.itemType === "note" ? openNote(item.id) : setOpenId(item.id),
                })
            }
          />
        )}
        {openId !== null && (
          <ItemDetailPanel
            key={openId}
            id={openId}
            onClose={() => setOpenId(null)}
            modal={detailSheet}
            suspended={searching || showingShortcuts || onboarding}
          />
        )}
      </div>
    </OpenItemContext.Provider>
  );
}
