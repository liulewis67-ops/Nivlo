import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TodayItemDto, TodayViewDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";
import { applyCompleted, applyReopened, findTodo } from "./model/today-view";

/** 完成后「撤销」提示停留的时间（毫秒）。 */
export const UNDO_WINDOW_MS = 5000;

/** [`useCompleteTodo`] 返回的操作。 */
export type CompleteTodoActions = {
  /** 完成一条待办：立即更新界面，失败时回滚并提示；成功后给出可撤销的 Toast。 */
  complete: (item: TodayItemDto) => Promise<void>;
  /** 重新打开一条今日已完成的待办。 */
  reopen: (item: TodayItemDto) => Promise<void>;
};

/**
 * 待办的完成 / 撤销，带 optimistic update（架构文档 §15）。
 *
 * 流程：取消进行中的 Today 查询 → 记下当前缓存 → 立即改缓存 → 调用 IPC →
 * 失败则恢复缓存并弹出错误 Toast；成功则显示带「撤销」的 Toast。
 * 撤销同样先改缓存再调 IPC；后端因为完成时没有清理 Today 顺序，重新打开后条目回到原位，
 * 之后由后端事件触发的重新查询校准最终结果。
 *
 * @returns 完成与重新打开两个操作。
 */
export function useCompleteTodo(): CompleteTodoActions {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const key = queryKeys.today();

  /** 失败后让缓存回到后端的真实状态。 */
  const resync = () => queryClient.invalidateQueries({ queryKey: key });

  /** 重新打开 `item` 并（乐观地）放回 `index`。 */
  async function reopenAt(item: TodayItemDto, index: number): Promise<void> {
    await queryClient.cancelQueries({ queryKey: key });
    const before = queryClient.getQueryData<TodayViewDto>(key);
    if (before !== undefined) queryClient.setQueryData(key, applyReopened(before, item, index));
    try {
      await ipc.reopenItem(item.id);
    } catch (error) {
      if (before !== undefined) queryClient.setQueryData(key, before);
      reportError(error);
      await resync();
    }
  }

  /**
   * 完成一条待办：乐观更新 → IPC → 失败回滚；成功后显示可撤销的 Toast。
   *
   * @param item 被完成的条目。
   */
  async function complete(item: TodayItemDto): Promise<void> {
    await queryClient.cancelQueries({ queryKey: key });
    const before = queryClient.getQueryData<TodayViewDto>(key);
    const position = before === undefined ? null : findTodo(before, item.id);
    if (before !== undefined) queryClient.setQueryData(key, applyCompleted(before, item.id));
    try {
      await ipc.completeItem(item.id);
    } catch (error) {
      if (before !== undefined) queryClient.setQueryData(key, before);
      reportError(error);
      await resync();
      return;
    }
    const original = position?.item ?? item;
    useToastStore
      .getState()
      .push("success", t("today.completedToast", { title: item.title }), UNDO_WINDOW_MS, {
        label: t("today.undo"),
        onClick: () => void reopenAt(original, position?.index ?? Number.MAX_SAFE_INTEGER),
      });
  }

  return {
    complete,
    reopen: (item) => reopenAt(item, Number.MAX_SAFE_INTEGER),
  };
}
