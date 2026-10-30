import { useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { distanceToNow } from "@/lib/date-format";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ConfirmButton, Input } from "@/components";
import { nextRemaining } from "@/lib/arrow-focus";
import { filterWords, matchesAllWords } from "@/lib/text-filter";
import { ipc } from "@/lib/ipc";
import type { TrashEntryDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";

/** 回收站里有这么多项时才显示筛选框。 */
export const TRASH_FILTER_MIN = 10;

/**
 * 距离自动永久清除还剩几天（按日历天数，最少 0）。
 *
 * @param entry 回收站里的一项。
 * @param now 现在。
 * @returns 剩余天数。
 */
export function daysLeft(entry: TrashEntryDto, now: Date = new Date()): number {
  return Math.max(0, differenceInCalendarDays(parseISO(entry.expiresAt), now));
}

/**
 * 回收站视图（实施计划 3.5、D-08）：被删除的条目在这里停留 30 天，可以恢复、彻底删除或清空。
 *
 * * 恢复：条目回到原来的样子（计划日期、项目、标签都在）；
 * * 彻底删除与清空是不可恢复的，需要在 3 秒内再点一次确认；
 * * 每一项显示删除了多久、还剩几天自动清除；
 * * 恢复或彻底删除一项后，焦点落在下一项的同一个按钮上，连续处理只要接着按。
 *
 * @returns 回收站页面。
 */
export function TrashPage() {
  const { t } = useTranslation();
  const trash = useQuery({
    queryKey: queryKeys.trash(),
    queryFn: () => ipc.listTrash(),
    staleTime: Infinity,
  });
  const entries = trash.data ?? [];
  const [filter, setFilter] = useState("");
  const words = filterWords(filter);
  // 按标题筛选：回收站最多留 30 天的东西，找回某一条时不用一路往下翻。
  const shown =
    words.length === 0
      ? entries
      : entries.filter((entry) => matchesAllWords(entry.item.title.toLocaleLowerCase(), words));
  const listRef = useRef<HTMLUListElement>(null);
  /** 处理完一项后要聚焦的那一项与按钮（0 恢复、1 彻底删除）；列表刷新后由下面的 Effect 聚焦。 */
  const refocus = useRef<{ id: string; button: number } | null>(null);

  /**
   * 记下处理完这一项后焦点该去哪儿（只在焦点就在列表里时）。
   *
   * @param id 要处理的那一项。
   * @param button 按的是第几个按钮。
   */
  function rememberNext(id: string, button: number): void {
    if (listRef.current?.contains(document.activeElement) !== true) return;
    const next = nextRemaining(
      shown.map((entry) => entry.item.id),
      [id],
    );
    refocus.current = next === null ? null : { id: next, button };
  }

  // 列表刷新（那一项已离开）后聚焦记下的按钮；焦点已经在别处时不抢。只操作 DOM，不改状态。
  useEffect(() => {
    const target = refocus.current;
    if (target === null) return;
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-trash-id]") ?? [])].find(
      (element) => element.dataset.trashId === target.id,
    );
    const button = row?.querySelectorAll<HTMLElement>("button")[target.button];
    if (button === undefined) return;
    refocus.current = null;
    if (document.activeElement === null || document.activeElement === document.body) {
      button.focus();
    }
  }, [trash.data]);

  /**
   * 恢复一项。
   *
   * @param entry 回收站里的一项。
   */
  function restore(entry: TrashEntryDto): void {
    rememberNext(entry.item.id, 0);
    ipc
      .restoreDeletedItems([entry.item.id])
      .then(() =>
        useToastStore.getState().push("success", t("trash.restored", { title: entry.item.title })),
      )
      .catch(reportError);
  }

  /**
   * 永久删除一项。
   *
   * @param entry 回收站里的一项。
   */
  function purge(entry: TrashEntryDto): void {
    rememberNext(entry.item.id, 1);
    ipc.purgeItems([entry.item.id]).catch(reportError);
  }

  /** 清空回收站。 */
  function empty(): void {
    ipc
      .emptyTrash()
      .then((count) => useToastStore.getState().push("success", t("trash.emptied", { count })))
      .catch(reportError);
  }

  return (
    <section aria-label={t("trash.label")} className="flex h-full min-w-0 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-text">{t("shell.nav.trash")}</h1>
          {entries.length > 0 && (
            <span className="text-sm text-muted tabular-nums">
              {t("trash.count", { count: entries.length })}
            </span>
          )}
        </div>
        {entries.length > 0 && (
          <ConfirmButton
            size="sm"
            label={t("trash.empty")}
            confirmLabel={t("trash.emptyConfirm")}
            onConfirm={empty}
          />
        )}
      </header>
      {(entries.length >= TRASH_FILTER_MIN || filter !== "") && (
        <div className="px-6 pt-3">
          <Input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter !== "") {
                event.preventDefault();
                event.stopPropagation();
                setFilter("");
              } else if (event.key === "ArrowDown") {
                const first = listRef.current?.querySelector<HTMLElement>("button");
                if (first === null || first === undefined) return;
                event.preventDefault();
                first.focus();
              }
            }}
            aria-label={t("trash.filter")}
            placeholder={t("trash.filter")}
            className="h-8"
          />
        </div>
      )}
      {trash.data === undefined ? null : entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
          <p className="text-base font-medium text-text">{t("trash.emptyTitle")}</p>
          <p className="max-w-sm text-sm text-muted">{t("trash.emptyHint")}</p>
        </div>
      ) : (
        <ul
          ref={listRef}
          aria-label={t("trash.list")}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          // ↑ / ↓ 移到上一项 / 下一项的同一个按钮（恢复或彻底删除），连续处理时不用 Tab 来回。
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const target = event.target;
            const row = target instanceof HTMLElement ? target.closest("li") : null;
            if (row === null || !(target instanceof HTMLElement)) return;
            const column = [...row.querySelectorAll("button")].indexOf(target as HTMLButtonElement);
            const sibling =
              event.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
            const next = sibling?.querySelectorAll<HTMLElement>("button")[column];
            if (column < 0 || next === undefined) return;
            event.preventDefault();
            next.focus();
          }}
        >
          {shown.length === 0 && (
            <li role="status" className="px-2 py-6 text-center text-sm text-muted">
              {t("trash.noMatch")}
            </li>
          )}
          {shown.map((entry) => {
            const left = daysLeft(entry);
            return (
              <li
                key={entry.item.id}
                data-trash-id={entry.item.id}
                className="group flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard) hover:bg-surface-hover"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text">{entry.item.title}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {t(`quickCreate.kind.${entry.item.itemType}`)}
                    {" · "}
                    {t("trash.deletedAgo", {
                      ago: distanceToNow(parseISO(entry.deletedAt), true),
                    })}
                    {" · "}
                    <span className={left <= 3 ? "text-danger" : undefined}>
                      {t("trash.daysLeft", { count: left })}
                    </span>
                  </p>
                </div>
                <Button
                  size="sm"
                  aria-label={t("trash.restore", { title: entry.item.title })}
                  onClick={() => restore(entry)}
                >
                  {t("trash.restoreShort")}
                </Button>
                <ConfirmButton
                  size="sm"
                  aria-label={t("trash.purge", { title: entry.item.title })}
                  label={t("trash.purgeShort")}
                  confirmLabel={t("trash.purgeConfirm")}
                  onConfirm={() => purge(entry)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
