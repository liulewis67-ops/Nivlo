import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { useShortcutQuery } from "@/features/shortcut";
import { trapTab } from "@/lib/focus-trap";
import type { ShortcutActionDto } from "@/lib/ipc";

/** [`ShortcutsDialog`] 的 Props。 */
export type ShortcutsDialogProps = {
  /** 关闭（Esc、点遮罩或「关闭」按钮）。 */
  onClose: () => void;
};

/** 一组快捷键：分组标题的文案键与各行（按键、说明的文案键）。 */
type Section = { title: string; rows: ReadonlyArray<readonly [keys: string, label: string]> };

/** 固定的快捷键（全局的两个取自真实绑定，单独渲染）。 */
const SECTIONS: readonly Section[] = [
  {
    title: "shortcuts.section.main",
    rows: [
      ["Ctrl+K", "shortcuts.main.search"],
      ["Ctrl+1 … 5", "shortcuts.main.views"],
      ["Ctrl+,", "shortcuts.main.settings"],
      ["Ctrl+Z", "shortcuts.main.undo"],
      ["?", "shortcuts.main.help"],
    ],
  },
  {
    title: "shortcuts.section.search",
    rows: [
      ["↑ ↓", "shortcuts.search.move"],
      ["↵", "shortcuts.search.open"],
      ["Ctrl+↵", "shortcuts.search.create"],
      ["Shift+↵", "shortcuts.search.copy"],
      ["Ctrl+D", "shortcuts.search.complete"],
      ["Ctrl+Z", "shortcuts.search.undo"],
      [">", "shortcuts.search.commands"],
      ["Esc", "shortcuts.search.close"],
    ],
  },
  {
    title: "shortcuts.section.quickCreate",
    rows: [
      ["↵", "shortcuts.quickCreate.create"],
      ["Tab", "shortcuts.quickCreate.kind"],
      ["Backspace", "shortcuts.quickCreate.date"],
      ["Esc", "shortcuts.quickCreate.cancel"],
    ],
  },
  {
    title: "shortcuts.section.inbox",
    rows: [
      ["↑ ↓", "shortcuts.inbox.move"],
      ["Ctrl+A", "shortcuts.inbox.all"],
      ["T", "shortcuts.inbox.today"],
      ["M", "shortcuts.inbox.tomorrow"],
      ["Delete", "shortcuts.inbox.delete"],
      ["Esc", "shortcuts.inbox.clear"],
    ],
  },
  {
    title: "shortcuts.section.today",
    rows: [
      ["↑ ↓", "shortcuts.today.move"],
      ["Ctrl+N", "shortcuts.today.add"],
      ["↓", "shortcuts.today.fromInput"],
      ["↵", "shortcuts.today.open"],
      ["M", "shortcuts.today.tomorrow"],
      ["Delete", "shortcuts.today.delete"],
      ["Space", "shortcuts.today.reorder"],
    ],
  },
  {
    title: "shortcuts.section.projects",
    rows: [
      ["↑ ↓", "shortcuts.projects.sidebar"],
      ["↑ ↓", "shortcuts.projects.move"],
    ],
  },
  {
    title: "shortcuts.section.workflows",
    rows: [["↑ ↓", "shortcuts.workflows.move"]],
  },
  {
    title: "shortcuts.section.trash",
    rows: [["↑ ↓", "shortcuts.trash.move"]],
  },
  {
    title: "shortcuts.section.calendar",
    rows: [
      ["J / K", "shortcuts.calendar.page"],
      ["T", "shortcuts.calendar.today"],
      ["M / W", "shortcuts.calendar.view"],
      ["← → ↑ ↓", "shortcuts.calendar.days"],
    ],
  },
  {
    title: "shortcuts.section.notes",
    rows: [
      ["Ctrl+N", "shortcuts.notes.new"],
      ["Ctrl+B / I", "shortcuts.notes.format"],
      ["Tab / Shift+Tab", "shortcuts.notes.indent"],
      ["↑ ↓", "shortcuts.notes.move"],
      ["↓ / Enter", "shortcuts.notes.filterOpen"],
      ["Esc", "shortcuts.notes.filterClear"],
    ],
  },
];

/**
 * 一行：右侧是按键。
 *
 * @param props 按键与说明。
 * @returns 表格行。
 */
function Row({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1 text-sm">
      <span className="text-text">{label}</span>
      <kbd className="shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-xs text-muted tabular-nums">
        {keys}
      </kbd>
    </div>
  );
}

/**
 * 全局快捷键一行：显示真实的绑定；被占用或停用时注明，免得照着按了没反应。
 *
 * @param props 动作。
 * @returns 表格行；状态还没读到时不显示。
 */
function GlobalRow({ action }: { action: ShortcutActionDto }) {
  const { t } = useTranslation();
  const status = useShortcutQuery(action).data;
  if (status === undefined) return null;
  const note = status.disabled
    ? t("shortcuts.global.disabled")
    : status.conflict
      ? t("shortcuts.global.taken")
      : null;
  return (
    <Row
      keys={note === null ? status.accelerator : `${status.accelerator}（${note}）`}
      label={t(`shortcuts.global.${action}`)}
    />
  );
}

/**
 * 键盘快捷键一览（主窗口里按 `?`，或 Ctrl+K 里的命令）。
 *
 * 快捷键分散在搜索框、快速创建与 Today 列表里，只有搜索框底部提示过一部分；这里集中列出。
 * 全局的两个取自真实绑定。Esc / 点遮罩关闭，关闭后焦点回到打开之前的元素。
 *
 * @param props 关闭回调。
 * @returns 模态对话框。
 */
export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    // 聚焦对话框本身（而不是底部的「关闭」按钮），打开时停在顶部，不会滚到最后一组。
    dialogRef.current?.focus();
    const target = previouslyFocused.current;
    return () => {
      if (target instanceof HTMLElement) target.focus();
    };
  }, []);

  /**
   * Esc 关闭。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    trapTab(event, dialogRef.current);
  }

  return (
    <div
      className="fixed inset-0 z-(--nv-z-dialog) flex items-center justify-center bg-text/30 px-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.title")}
        onKeyDown={handleKeyDown}
        className="nv-panel-in flex max-h-[min(44rem,85vh)] w-full max-w-lg flex-col sm:max-w-3xl gap-4 overflow-y-auto rounded-xl border border-border bg-surface p-6 shadow-lg focus-visible:outline-none"
      >
        <h2 className="text-lg font-semibold text-text">{t("shortcuts.title")}</h2>
        {/* 分组较多：窗口够宽时排成两栏（每组不拆开），一屏基本看得全。 */}
        <div className="gap-x-8 sm:columns-2 [&>section]:mb-4 [&>section]:break-inside-avoid">
          <section aria-label={t("shortcuts.section.global")}>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted">
              {t("shortcuts.section.global")}
            </h3>
            <GlobalRow action="quickCreate" />
            <GlobalRow action="search" />
          </section>
          {SECTIONS.map((section) => (
            <section key={section.title} aria-label={t(section.title)}>
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted">
                {t(section.title)}
              </h3>
              {section.rows.map(([keys, label]) => (
                <Row key={label} keys={keys} label={t(label)} />
              ))}
            </section>
          ))}
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>
            {t("shortcuts.close")}
          </Button>
        </div>
      </div>
    </div>
  );
}
