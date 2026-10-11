import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import type { InboxEntryDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { buildPatch, dropSaved, toDraft } from "./model/item-draft";
import type { ItemDraft } from "./model/item-draft";

/** 停止输入多久之后自动保存（毫秒）。 */
export const AUTOSAVE_DELAY_MS = 700;

/** 保存状态。 */
export type SaveStatus = "idle" | "saving" | "saved" | "error";

/** [`useItemDraft`] 的返回值。 */
export type ItemDraftState = {
  /** 详情查询（含加载 / 出错状态）。 */
  query: ReturnType<typeof useQuery<InboxEntryDto>>;
  /** 后端当前的详情；还没加载好时为 `undefined`。 */
  detail: InboxEntryDto | undefined;
  /** 表单草稿（后端数据 + 尚未保存的修改）；还没加载好时为 `null`。 */
  draft: ItemDraft | null;
  /** 保存状态。 */
  status: SaveStatus;
  /** 保存失败的原因（已翻译）；没有失败时为 `null`。 */
  problem: string | null;
  /** 修改一个或几个字段。 */
  edit: (change: Partial<ItemDraft>) => void;
  /** 立即保存（失败后点「重试」）。 */
  save: () => Promise<void>;
};

/**
 * 一个 Item 的编辑草稿 + 自动保存（实施计划 3.1 / 3.2 共用）。
 *
 * * 草稿 = 后端数据叠加尚未保存的修改；后端数据在编辑期间被刷新（别处改了同一条）也不会冲掉用户的输入；
 * * **自动保存**：停止输入 [`AUTOSAVE_DELAY_MS`] 毫秒后保存，只发送相对后端数据真正变化的字段；
 *   卸载（关闭面板 / 切换条目）时先把未保存的修改保存掉；
 * * **保存失败不丢内容**：修改仍保留在草稿里，`problem` 给出原因，`save` 可重试，继续编辑也会再次尝试；
 *   保存期间又改过的字段不会被误当成已保存。
 *
 * @param id Item ID。切换到另一个 Item 时请用 `key` 重新挂载使用它的组件。
 * @returns 草稿与保存状态。
 */
export function useItemDraft(id: string): ItemDraftState {
  const queryClient = useQueryClient();
  const detailKey = queryKeys.itemDetail(id);
  const query = useQuery({
    queryKey: detailKey,
    queryFn: () => ipc.getItemDetail(id),
    staleTime: 0,
  });
  const item = query.data?.item;

  /** 尚未保存的修改（覆盖在后端数据之上）。 */
  const [edits, setEdits] = useState<Partial<ItemDraft>>({});
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const draft: ItemDraft | null = item === undefined ? null : { ...toDraft(item), ...edits };
  const patch = item === undefined || draft === null ? null : buildPatch(item, draft);

  /** 最新的 Item 与草稿，供异步保存与卸载时的保存读取（避免闭包里拿到过期值）。 */
  const latestRef = useRef<{ item: typeof item; draft: ItemDraft | null }>({ item, draft });
  const savingRef = useRef(false);
  useEffect(() => {
    latestRef.current = { item, draft };
  });

  /** 保存：发送相对后端数据的差异；成功后去掉已保存的字段，失败时保留一切并说明原因。 */
  async function save(): Promise<void> {
    const { item: current, draft: sent } = latestRef.current;
    if (current === undefined || sent === null || savingRef.current) return;
    const request = buildPatch(current, sent);
    if (request === null) return;
    savingRef.current = true;
    setStatus("saving");
    try {
      const saved = await ipc.updateItem(id, request);
      queryClient.setQueryData<InboxEntryDto>(detailKey, (old) =>
        old === undefined ? old : { ...old, item: saved },
      );
      setEdits((previous) => dropSaved(previous, sent));
      setStatus("saved");
      setProblem(null);
    } catch (error) {
      setStatus("error");
      setProblem(errorMessage(toAppError(error)));
    } finally {
      savingRef.current = false;
    }
  }
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  // 停止输入一会儿之后自动保存；每次差异变化都重新计时。
  const patchKey = JSON.stringify(patch);
  useEffect(() => {
    if (patchKey === "null") return;
    const timer = setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [patchKey]);

  // 卸载（关闭面板 / 切换条目）时把还没保存的修改保存掉。
  useEffect(
    () => () => {
      void saveRef.current();
    },
    [],
  );

  /**
   * 修改一个或几个字段。
   *
   * @param change 要覆盖的字段。
   */
  function edit(change: Partial<ItemDraft>): void {
    setEdits((previous) => ({ ...previous, ...change }));
    if (status === "saved" || status === "error") setStatus("idle");
  }

  return { query, detail: query.data, draft, status, problem, edit, save };
}
