import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";

/**
 * 查询项目（侧栏用，不含已归档的），带各自未完成的条目数。
 *
 * 项目的数量取决于条目，所以条目变化的事件会让它失效（见 `AppProviders`）。
 *
 * @returns TanStack Query 结果，`data` 为 `ProjectDto[]`。
 */
export function useProjectsQuery() {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => ipc.listProjects(false),
    staleTime: Infinity,
  });
}

/**
 * 查询全部标签与各自的条目数（标签管理与自动补全共用）。
 *
 * @returns TanStack Query 结果，`data` 为 `TagSummaryDto[]`。
 */
export function useTagsQuery() {
  return useQuery({
    queryKey: queryKeys.tags(),
    queryFn: () => ipc.listTags(),
    staleTime: Infinity,
  });
}
