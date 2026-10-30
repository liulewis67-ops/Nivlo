import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { RescheduleTargetDto, TodayItemDto, TodayViewDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";
import { applyPostponed, applyReopened, findTodo } from "./model/today-view";
import { UNDO_WINDOW_MS } from "./useCompleteTodo";

/** 可以从 Today 面板选择的改期目标种类。 */
export type PostponeKind = "today" | "tomorrow" | "later" | "inbox";

/** [`useRescheduleTodo`] 返回的操作。 */
export type RescheduleTodoActions = {
  /** 把一条待办改期：立即从列表消失，失败时回滚；成功后给出可撤销的 Toast。 */
  postpone: (item: TodayItemDto, kind: PostponeKind) => Promise<void>;
};

/**
 * 待办的推迟（改期），带 optimistic update 与撤销（实施计划 1.8）。
 *
 * 撤销 = 把计划**精确恢复**到改期之前，再用改期前的完整顺序重新保存 Today 顺序，
 * 所以待办回到原来的位置（后端在改期时已清掉了它的顺序记录）。
 *
 * @returns 改期操作。
 */
export function useRescheduleTodo(): RescheduleTodoActions {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const key = queryKeys.today();

  /** 失败后让缓存回到后端的真实状态。 */
  const resync = () => queryClient.invalidateQueries({ queryKey: key });

  /**
   * 撤销一次改期：乐观放回 → 精确恢复计划 → 恢复完整顺序。
   *
   * @param original 改期前的条目。
   * @param index 改期前在待办列表中的下标。
   * @param orderBefore 改期前完整的待办顺序。
   */
  async function undo(original: TodayItemDto, index: number, orderBefore: string[]): Promise<void> {
    await queryClient.cancelQueries({ queryKey: key });
    const before = queryClient.getQueryData<TodayViewDto>(key);
    if (before !== undefined) queryClient.setQueryData(key, applyReopened(before, original, index));
    try {
      await ipc.rescheduleItem(original.id, { kind: "exact", scheduled: original.scheduled });
      await ipc.reorderToday(orderBefore);
    } catch (error) {
      reportError(error);
      await resync();
    }
  }

  /**
   * 改期一条待办：乐观更新 → IPC → 失败回滚；成功后显示可撤销的 Toast。
   *
   * @param item 被改期的条目。
   * @param kind 改期目标。
   */
  async function postpone(item: TodayItemDto, kind: PostponeKind): Promise<void> {
    await queryClient.cancelQueries({ queryKey: key });
    const before = queryClient.getQueryData<TodayViewDto>(key);
    const position = before === undefined ? null : findTodo(before, item.id);
    const orderBefore = before?.todos.map((todo) => todo.id) ?? [];
    // 改期到「今天」的逾期待办仍然留在 Today 里，只是不再逾期，无需从列表移除。
    if (before !== undefined && kind !== "today") {
      queryClient.setQueryData(key, applyPostponed(before, item.id));
    }
    const target: RescheduleTargetDto = { kind };
    try {
      await ipc.rescheduleItem(item.id, target);
    } catch (error) {
      if (before !== undefined) queryClient.setQueryData(key, before);
      reportError(error);
      await resync();
      return;
    }
    const original = position?.item ?? item;
    useToastStore
      .getState()
      .push("success", t(`today.postpone.toast.${kind}`, { title: item.title }), UNDO_WINDOW_MS, {
        label: t("today.undo"),
        undo: true,
        onClick: () => void undo(original, position?.index ?? orderBefore.length, orderBefore),
      });
  }

  return { postpone };
}
