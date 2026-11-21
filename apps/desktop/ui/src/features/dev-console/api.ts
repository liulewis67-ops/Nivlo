import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import type { CreateItemRequest } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";

/** 开发控制台列表的过滤条件：不含已归档。 */
const LIST_FILTER = { includeArchived: false } as const;

/**
 * 查询最近的 Item 列表。
 *
 * 数据只在挂载时请求一次，之后由后端事件（`item_created` / `item_updated`）让它失效并重取。
 *
 * @returns TanStack Query 结果，`data` 为从新到旧排序的 Item。
 */
export function useItemsQuery() {
  return useQuery({
    queryKey: queryKeys.itemList(LIST_FILTER),
    queryFn: () => ipc.listItems({ itemType: null, includeArchived: false, limit: 50 }),
  });
}

/**
 * 创建 Item 的 Mutation。
 *
 * 创建成功后让 Item 列表失效以重新读取；失败由全局 `MutationCache` 弹出错误 Toast。
 *
 * @returns TanStack Mutation 结果。
 */
export function useCreateItemMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateItemRequest) => ipc.createItem(request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.items() }),
  });
}
