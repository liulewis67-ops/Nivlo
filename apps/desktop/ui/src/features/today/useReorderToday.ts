import { useQueryClient } from "@tanstack/react-query";
import type { TodayViewDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { applyMove } from "./model/today-view";

/**
 * Today 待办的拖拽 / 键盘排序，带 optimistic update：先改缓存让列表立即落位，
 * 再持久化；失败则恢复缓存、提示错误并重新查询。
 *
 * @returns \`move(activeId, overId)\`：把 \`activeId\` 放到 \`overId\` 的位置并保存。
 */
export function useReorderToday(): (activeId: string, overId: string) => Promise<void> {
  const queryClient = useQueryClient();
  const key = queryKeys.today();

  return async (activeId, overId) => {
    await queryClient.cancelQueries({ queryKey: key });
    const before = queryClient.getQueryData<TodayViewDto>(key);
    if (before === undefined) return;
    const after = applyMove(before, activeId, overId);
    if (after === before) return;
    queryClient.setQueryData(key, after);
    try {
      await ipc.reorderToday(after.todos.map((todo) => todo.id));
    } catch (error) {
      queryClient.setQueryData(key, before);
      reportError(error);
      await queryClient.invalidateQueries({ queryKey: key });
    }
  };
}
