import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";

/**
 * 查询全局快捷键的绑定与注册状态。
 *
 * 状态只在用户修改绑定时变化，所以只取一次、由 [`ShortcutSetting`](./ShortcutSetting.tsx) 在保存后直接更新缓存。
 *
 * @returns TanStack Query 结果，`data` 为 `ShortcutStatusDto`。
 */
export function useShortcutQuery() {
  return useQuery({
    queryKey: queryKeys.shortcut(),
    queryFn: () => ipc.getShortcutStatus(),
    staleTime: Infinity,
  });
}
