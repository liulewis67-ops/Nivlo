import { create } from "zustand";

/** 草稿保存的明确结果；失败不能当作允许离开。 */
export type FlushOutcome = "success" | "error" | "cancelled";

/** 只协调临时编辑草稿，不持有业务数据。 */
type DraftGuard = {
  /** 编辑器实例标识。 */
  owner: string;
  /** 活动模态编辑器优先于背后的编辑器。 */
  priority: number;
  /** 包含正在保存的版本。 */
  isDirty: () => boolean;
  /** 等待当前请求并保存其间的新修改。 */
  flush: () => Promise<FlushOutcome>;
  /** 仅清除这个编辑器的草稿。 */
  discard: () => Promise<void>;
  /** 供活动模态表面呈现背后编辑器的错误及名称。 */
  describeError: () => { message: string; title: string };
};

/** 导航期间的草稿恢复状态。 */
type DraftTransitionState = {
  /** 正在阻止离开的编辑器。 */
  blockedOwner: string | null;
  /** 失败草稿的临时提示。 */
  failedDraft: { message: string; title: string } | null;
  /** 是否已打开二次放弃确认。 */
  confirmingDiscard: boolean;
  /** 正在保存或放弃，防止重复操作。 */
  busy: boolean;
  /** 注册编辑器；返回只注销该实例的清理函数。 */
  register: (guard: DraftGuard) => () => void;
  /** 请求离开；连续请求只保留最新目的地。 */
  request: (apply: () => void) => void;
  /** 重试后才应用尚未取消的最新目的地。 */
  retry: () => void;
  /** 留在原处，清除目的地但保留草稿。 */
  cancel: () => void;
  /** 显示 / 取消二次确认。 */
  askDiscard: (confirming: boolean) => void;
  /** 确认只放弃当前失败草稿，再检查其他编辑器。 */
  discard: () => Promise<void>;
};

/** 编辑器离开协调器：在途请求串行，目的地最新请求优先，取消不执行旧回调。 */
export const useDraftTransitionStore = create<DraftTransitionState>((set, get) => {
  const guards = new Map<string, DraftGuard>();
  let pending: (() => void) | null = null;
  let running = false;

  /** 保存所有活动草稿；过程中再次请求只替换目的地。 */
  async function run(): Promise<void> {
    if (running || pending === null) return;
    running = true;
    set({ busy: true, blockedOwner: null, failedDraft: null, confirmingDiscard: false });
    try {
      while (pending !== null) {
        const guard = [...guards.values()]
          .sort((a, b) => b.priority - a.priority)
          .find((entry) => entry.isDirty());
        if (guard === undefined) {
          const apply = pending;
          pending = null;
          apply();
          continue;
        }
        const outcome = await guard.flush();
        if (pending === null) break;
        if (outcome !== "success") {
          set({ blockedOwner: guard.owner, failedDraft: guard.describeError() });
          break;
        }
      }
    } finally {
      running = false;
      set({ busy: false });
    }
  }

  return {
    blockedOwner: null,
    failedDraft: null,
    confirmingDiscard: false,
    busy: false,
    register: (guard) => {
      guards.set(guard.owner, guard);
      return () => {
        if (guards.get(guard.owner) !== guard) return;
        guards.delete(guard.owner);
        if (get().blockedOwner === guard.owner) get().cancel();
      };
    },
    request: (apply) => {
      pending = apply;
      if (get().blockedOwner === null) void run();
    },
    retry: () => {
      void run();
    },
    cancel: () => {
      pending = null;
      set({ blockedOwner: null, failedDraft: null, confirmingDiscard: false });
    },
    askDiscard: (confirming) => set({ confirmingDiscard: confirming }),
    discard: async () => {
      const guard = guards.get(get().blockedOwner ?? "");
      if (guard === undefined || running || !get().confirmingDiscard) return;
      running = true;
      set({ busy: true });
      try {
        await guard.discard();
      } finally {
        running = false;
        set({ busy: false, blockedOwner: null, failedDraft: null, confirmingDiscard: false });
      }
      void run();
    },
  };
});
