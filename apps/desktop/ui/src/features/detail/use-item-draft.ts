import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import type { InboxEntryDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { useDraftTransitionStore } from "@/stores/draft-transition-store";
import type { FlushOutcome } from "@/stores/draft-transition-store";
import { buildPatch, dropSaved, toDraft } from "./model/item-draft";
import type { ItemDraft } from "./model/item-draft";
import { reminderToUtc } from "./model/reminder-presets";

/** 停止输入多久之后自动保存（毫秒）。 */
export const AUTOSAVE_DELAY_MS = 700;
/** 保存状态。 */
export type SaveStatus = "idle" | "saving" | "saved" | "error";
/** 编辑器共享的草稿及离开契约。 */
export type ItemDraftState = {
  /** 详情查询。 */
  query: ReturnType<typeof useQuery<InboxEntryDto>>;
  /** 后端当前详情。 */
  detail: InboxEntryDto | undefined;
  /** 后端数据叠加未保存修改。 */
  draft: ItemDraft | null;
  /** 保存状态。 */
  status: SaveStatus;
  /** 持续可见的失败原因。 */
  problem: string | null;
  /** 用于恢复提示定位当前编辑器。 */
  owner: string;
  /** 修改字段。 */
  edit: (change: Partial<ItemDraft>) => void;
  /** 等待在途保存并串行保存所有后续修改。 */
  save: () => Promise<FlushOutcome>;
};

/**
 * Item / Note 共用的临时草稿；响应只确认发送的字段版本。
 * 正常关闭 / 切换必须经过草稿协调器；卸载保存只是最后保障，不能作为成功离开的证据。
 *
 * @param id 条目 ID；换条目时由父级在成功离开后重新挂载。
 * @param priority 模态详情优先于背后的笔记。
 * @returns 草稿、明确的保存结果及实例标识。
 */
export function useItemDraft(id: string, priority = 10): ItemDraftState {
  const { t } = useTranslation();
  const owner = useId();
  const queryClient = useQueryClient();
  const detailKey = queryKeys.itemDetail(id);
  const query = useQuery({
    queryKey: detailKey,
    queryFn: () => ipc.getItemDetail(id),
    staleTime: 0,
  });
  const item = query.data?.item;
  const [edits, setEdits] = useState<Partial<ItemDraft>>({});
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const baseRef = useRef(item);
  const editsRef = useRef<Partial<ItemDraft>>({});
  const savingRef = useRef<Promise<FlushOutcome> | null>(null);
  const problemRef = useRef<string | null>(null);
  useEffect(() => {
    baseRef.current = item;
  }, [item]);
  const draft = item === undefined ? null : { ...toDraft(item), ...edits };

  /** 运行一次串行保存，直到最新版本已确认或发生错误。 */
  async function flush(): Promise<FlushOutcome> {
    for (;;) {
      const current = baseRef.current;
      if (current === undefined) return "success";
      const sent = { ...toDraft(current), ...editsRef.current };
      if (sent.reminder !== "" && reminderToUtc(sent.reminder) === null) {
        problemRef.current = t("detail.incompleteReminder");
        setProblem(problemRef.current);
        setStatus("error");
        return "error";
      }
      const request = buildPatch(current, sent);
      if (request === null) {
        if (
          Object.entries(editsRef.current).some(
            ([key, value]) => toDraft(current)[key as keyof ItemDraft] !== value,
          )
        ) {
          problemRef.current = t("detail.incompleteDate");
          setProblem(problemRef.current);
          setStatus("error");
          return "error";
        }
        editsRef.current = {};
        setEdits({});
        setStatus("saved");
        setProblem(null);
        problemRef.current = null;
        return "success";
      }
      setStatus("saving");
      try {
        const saved = await ipc.updateItem(id, request);
        baseRef.current = saved;
        editsRef.current = dropSaved(editsRef.current, sent);
        setEdits(editsRef.current);
        queryClient.setQueryData<InboxEntryDto>(detailKey, (old) => old && { ...old, item: saved });
        if (Object.keys(editsRef.current).length === 0) {
          setStatus("saved");
          setProblem(null);
          problemRef.current = null;
          return "success";
        }
      } catch (error) {
        setStatus("error");
        problemRef.current = errorMessage(toAppError(error));
        setProblem(problemRef.current);
        return "error";
      }
    }
  }

  /** 同时调用返回同一个请求；不会把「正在保存」误当作「已保存」。 */
  function save(): Promise<FlushOutcome> {
    if (savingRef.current !== null) return savingRef.current;
    const flight = flush();
    savingRef.current = flight;
    void flight.then(() => {
      if (savingRef.current === flight) savingRef.current = null;
    });
    return flight;
  }
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(
    () =>
      useDraftTransitionStore.getState().register({
        owner,
        priority,
        isDirty: () => {
          if (savingRef.current !== null) return true;
          const base = baseRef.current;
          return (
            base !== undefined &&
            Object.entries(editsRef.current).some(
              ([key, value]) => toDraft(base)[key as keyof ItemDraft] !== value,
            )
          );
        },
        flush: () => saveRef.current(),
        describeError: () => ({
          message: problemRef.current ?? "",
          title: editsRef.current.title ?? baseRef.current?.title ?? "",
        }),
        discard: async () => {
          await savingRef.current;
          editsRef.current = {};
          setEdits({});
          setProblem(null);
          setStatus("idle");
          problemRef.current = null;
        },
      }),
    [owner, priority],
  );

  const editKey = JSON.stringify(edits);
  useEffect(() => {
    if (editKey === "{}") return;
    const timer = setTimeout(() => {
      if (useDraftTransitionStore.getState().blockedOwner !== owner) void saveRef.current();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [editKey, owner]);

  useEffect(
    () => () => {
      void saveRef.current();
    },
    [],
  );

  /** 同步记录输入供同一事件中的导航读取，不等待下一次渲染。 */
  function edit(change: Partial<ItemDraft>): void {
    editsRef.current = { ...editsRef.current, ...change };
    setEdits(editsRef.current);
    if (status === "saved") setStatus("idle");
  }
  return { query, detail: query.data, draft, status, problem, owner, edit, save };
}
