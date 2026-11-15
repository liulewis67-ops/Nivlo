import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { InboxEntryDto, OrganizeActionDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";
import { formatDate } from "@/lib/date-format";
import { parseISO } from "date-fns";

/** 整理动作的种类（界面上的按钮与菜单项）。 */
export type OrganizeKind =
  "today" | "tomorrow" | "later" | "todo" | "note" | "tip" | "leave" | "archive" | { date: string };

/** 整理完成后「撤销」按钮停留多久（毫秒）。 */
export const ORGANIZE_UNDO_MS = 6000;

/**
 * 把界面上的整理种类变成 IPC 动作。
 *
 * @param kind 整理种类。
 * @returns IPC 动作。
 */
export function toAction(kind: OrganizeKind): OrganizeActionDto {
  if (typeof kind === "object")
    return { kind: "schedule", target: { kind: "date", date: kind.date } };
  switch (kind) {
    case "today":
    case "tomorrow":
    case "later":
      return { kind: "schedule", target: { kind } };
    case "todo":
    case "note":
    case "tip":
      return { kind: "convertTo", item_type: kind };
    case "leave":
      return { kind: "leaveInbox" };
    case "archive":
      return { kind: "archive" };
  }
}

/** [`useOrganize`] 返回的操作。 */
export type OrganizeActions = {
  /**
   * 对一批 Item 执行整理动作：条目立即从列表消失（乐观更新），失败时回滚并提示；
   * 成功后给出可撤销的 Toast。
   *
   * @param ids 被整理的 Item ID。
   * @param kind 整理种类。
   * @param title 只有一条时，用于 Toast 文案里的标题。
   * @returns 是否成功。
   */
  organize: (ids: string[], kind: OrganizeKind, title?: string) => Promise<boolean>;
};

/**
 * Inbox 的整理操作，带 optimistic update 与撤销（实施计划 2.7）。
 *
 * 撤销调用后端的 `restore_items`，把每个 Item 精确恢复到整理之前（含它当时在 Inbox 里）。
 *
 * @returns 整理操作。
 */
export function useOrganize(): OrganizeActions {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const listKey = queryKeys.inbox();
  const countKey = queryKeys.inboxCount();

  /** 让 Inbox 的列表与数量回到后端的真实状态。 */
  const resync = () => queryClient.invalidateQueries({ queryKey: listKey });

  /** 乐观移除 → IPC → 失败回滚；成功后显示可撤销的 Toast。 */
  async function organize(ids: string[], kind: OrganizeKind, title?: string): Promise<boolean> {
    if (ids.length === 0) return false;
    await queryClient.cancelQueries({ queryKey: listKey });
    const before = queryClient.getQueryData<InboxEntryDto[]>(listKey);
    const countBefore = queryClient.getQueryData<number>(countKey);
    const removed = new Set(ids);
    const exact = typeof kind === "object";
    if (!exact && before !== undefined) {
      queryClient.setQueryData(
        listKey,
        before.filter((entry) => !removed.has(entry.item.id)),
      );
    }
    if (!exact && countBefore !== undefined) {
      const stillThere = before?.filter((entry) => removed.has(entry.item.id)).length ?? ids.length;
      queryClient.setQueryData(countKey, Math.max(0, countBefore - stillThere));
    }
    try {
      const outcome = await ipc.organizeItems(ids, toAction(kind));
      useToastStore.getState().push(
        "success",
        exact
          ? t("calendar.scheduled", {
              title: title ?? "",
              date: formatDate(parseISO(kind.date), "monthDay"),
            })
          : t(`inbox.done.${kind}`, { count: ids.length, title: title ?? "" }),
        ORGANIZE_UNDO_MS,
        {
          label: t("inbox.undo"),
          undo: true,
          onClick: () => {
            void ipc
              .restoreItems(outcome.previous)
              .catch(reportError)
              .finally(() => void resync());
          },
        },
      );
      return true;
    } catch (error) {
      if (!exact && before !== undefined) queryClient.setQueryData(listKey, before);
      if (!exact && countBefore !== undefined) queryClient.setQueryData(countKey, countBefore);
      reportError(error);
      await resync();
      return false;
    }
  }

  return { organize };
}
