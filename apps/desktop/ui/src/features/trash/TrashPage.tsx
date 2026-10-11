import { useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { distanceToNow } from "@/lib/date-format";
import { useTranslation } from "react-i18next";
import { Button, ConfirmButton } from "@/components";
import { ipc } from "@/lib/ipc";
import type { TrashEntryDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";

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
 * * 每一项显示删除了多久、还剩几天自动清除。
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

  /**
   * 恢复一项。
   *
   * @param entry 回收站里的一项。
   */
  function restore(entry: TrashEntryDto): void {
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
      {trash.data === undefined ? null : entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
          <p className="text-base font-medium text-text">{t("trash.emptyTitle")}</p>
          <p className="max-w-sm text-sm text-muted">{t("trash.emptyHint")}</p>
        </div>
      ) : (
        <ul aria-label={t("trash.list")} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {entries.map((entry) => {
            const left = daysLeft(entry);
            return (
              <li
                key={entry.item.id}
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
