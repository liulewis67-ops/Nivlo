import type { DragEndEvent } from "@dnd-kit/core";
import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import type { DragPayload } from "./CalendarChip";
import { AppError } from "@/lib/errors";

/** 被替换的 `DndContext` 捕获到的拖拽结束回调。 */
const captured: { onDragEnd: ((event: DragEndEvent) => void) | null } = { onDragEnd: null };

// 指针拖拽在 jsdom 里没有布局信息，无法真实模拟；这里替换 DndContext，直接触发它的 onDragEnd，
// 验证「落在某一天 → 重新安排 → 提示与撤销」这条链路（碰撞检测与拖动手感由 dnd-kit 负责）。
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode;
      onDragEnd: (event: DragEndEvent) => void;
    }) => {
      captured.onDragEnd = onDragEnd;
      return <>{children}</>;
    },
  };
});

const { CalendarPage } = await import("./CalendarPage");

/** 创建一个待办。 */
async function seed(
  ipc: MemoryIpc,
  title: string,
  scheduled: { date: string; time: string | null } | null,
): Promise<string> {
  const item = await ipc.createItem({
    itemType: "todo",
    title,
    content: null,
    contentFormat: "plain",
    priority: null,
    scheduled,
    due: null,
    reminderAt: null,
    projectId: null,
  });
  return item.id;
}

/** 模拟把条目拖到某一天并放下。 */
function dropOn(payload: DragPayload, date: string | null): void {
  act(() => {
    captured.onDragEnd?.({
      active: {
        id: "x",
        data: { current: payload },
        rect: { current: { initial: null, translated: null } },
      },
      over: date === null ? null : { id: date },
    } as unknown as DragEndEvent);
  });
}

/** 构造拖拽携带的数据。 */
function payload(
  id: string,
  title: string,
  scheduled: { date: string; time: string | null } | null,
): DragPayload {
  return {
    item: {
      id,
      itemType: "todo",
      title,
      status: "open",
      priority: "none",
      scheduled,
      due: null,
    },
    fromDate: scheduled?.date ?? null,
  };
}

describe("拖拽排期", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    captured.onDragEnd = null;
  });

  it("排期和撤销失败会报告错误，保留最近一次已成功保存的日期", async () => {
    const ipc = createMemoryIpc();
    const original = { date: "2026-10-14", time: "10:30:00" };
    const id = await seed(ipc, "评审", original);
    const change = vi.spyOn(ipc, "rescheduleItem");
    change.mockRejectedValueOnce(new AppError("STORAGE_UNAVAILABLE", "injected"));
    renderWithProviders(<CalendarPage />, ipc);
    await screen.findByRole("heading", { name: "2026年10月" });
    dropOn(payload(id, "评审", original), "2026-10-21");
    await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.kind).toBe("error"));
    expect(ipc.items.find((item) => item.id === id)?.scheduled).toEqual(original);
    dropOn(payload(id, "评审", original), "2026-10-21");
    await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.kind).toBe("success"));
    const undo = useToastStore.getState().toasts.at(-1)?.action;
    change.mockRejectedValueOnce(new AppError("STORAGE_UNAVAILABLE", "injected"));
    act(() => undo?.onClick());
    await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.kind).toBe("error"));
    expect(ipc.items.find((item) => item.id === id)?.scheduled).toEqual({
      ...original,
      date: "2026-10-21",
    });
  });

  it("从「待安排」拖到某一天：计划日期设为那天、离开待安排、出现在那天，并可撤销", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "订机票", null);
    renderWithProviders(<CalendarPage />, ipc);
    await screen.findByRole("heading", { name: "2026年10月" });
    await waitFor(() => expect(screen.getAllByText("订机票")).toHaveLength(1));

    dropOn(payload(id, "订机票", null), "2026-10-15");

    await waitFor(() =>
      expect(ipc.items.find((i) => i.id === id)?.scheduled).toEqual({
        date: "2026-10-15",
        time: null,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("gridcell", { name: "10月15日 星期四" })).toHaveTextContent("订机票"),
    );
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.message).toBe("「订机票」已安排到 10月15日");

    // 撤销：回到「没有日期」，重新出现在待安排里。
    act(() => toast?.action?.onClick());
    await waitFor(() => expect(ipc.items.find((i) => i.id === id)?.scheduled).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "待安排" })).toHaveTextContent("订机票"),
    );
  });

  it("日期之间拖动：改日期并保留原有的具体时间；撤销恢复原日期", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "评审", { date: "2026-10-14", time: "10:30:00" });
    renderWithProviders(<CalendarPage />, ipc);
    await screen.findByRole("heading", { name: "2026年10月" });

    dropOn(payload(id, "评审", { date: "2026-10-14", time: "10:30:00" }), "2026-10-21");

    await waitFor(() =>
      expect(ipc.items.find((i) => i.id === id)?.scheduled).toEqual({
        date: "2026-10-21",
        time: "10:30:00",
      }),
    );
    const toast = useToastStore.getState().toasts.at(-1);
    act(() => toast?.action?.onClick());
    await waitFor(() =>
      expect(ipc.items.find((i) => i.id === id)?.scheduled).toEqual({
        date: "2026-10-14",
        time: "10:30:00",
      }),
    );
  });

  it("放回原来的日期、或没有放在任何一格上：什么都不发生", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "原地不动", { date: "2026-10-14", time: null });
    renderWithProviders(<CalendarPage />, ipc);
    await screen.findByRole("heading", { name: "2026年10月" });

    dropOn(payload(id, "原地不动", { date: "2026-10-14", time: null }), "2026-10-14");
    dropOn(payload(id, "原地不动", { date: "2026-10-14", time: null }), null);

    expect(ipc.calls).not.toContain("rescheduleItem");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
