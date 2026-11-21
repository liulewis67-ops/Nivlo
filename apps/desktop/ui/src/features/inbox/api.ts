import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";

/**
 * 查询 Inbox：等待整理的 Item（捕获时间从新到旧），带来源与附件。
 *
 * 由后端数据变更事件让缓存失效并重取；主窗口里整理动作用乐观更新，所以条目会立刻消失。
 *
 * @returns TanStack Query 结果，`data` 为 `InboxEntryDto[]`。
 */
export function useInboxQuery() {
  return useQuery({
    queryKey: queryKeys.inbox(),
    queryFn: () => ipc.listInbox(),
    staleTime: Infinity,
  });
}

/**
 * 查询 Inbox 里有多少条等待整理（侧栏角标）。
 *
 * @returns TanStack Query 结果，`data` 为数量。
 */
export function useInboxCountQuery() {
  return useQuery({
    queryKey: queryKeys.inboxCount(),
    queryFn: () => ipc.getInboxCount(),
    staleTime: Infinity,
  });
}
