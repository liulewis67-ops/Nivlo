import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";

/**
 * 查询今天的视图（待办已按 Today Order 排序，含逾期；另有提示与今日已完成）。
 *
 * 只在首次挂载时向后端请求一次；之后由后端数据变更事件
 * （`item_created`、`item_updated`、`today_reordered`、`day_changed`）让缓存失效并重取。
 * `staleTime: Infinity` 保证 Hover 展开重新挂载面板时不会再次请求——Hover 视觉响应
 * 只使用已缓存的数据（架构文档 §12、前端规范 §9）。
 *
 * @returns TanStack Query 结果，`data` 为后端返回的 `TodayViewDto`。
 */
export function useTodayQuery() {
  return useQuery({
    queryKey: queryKeys.today(),
    queryFn: () => ipc.getToday(),
    staleTime: Infinity,
  });
}
