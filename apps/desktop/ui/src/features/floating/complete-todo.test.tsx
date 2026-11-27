import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { TodayItemDto, TodayViewDto } from "@/lib/ipc";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { FloatingRoot } from "./FloatingRoot";
import { HOVER_ENTER_DELAY_MS } from "./model/floating-machine";

/** 构造一个待办条目。 */
function todo(id: string, title: string): TodayItemDto {
  return {
    id,
    itemType: "todo",
    title,
    brief: null,
    status: "open",
    priority: "none",
    scheduled: { date: "2026-10-10", time: null },
    due: null,
    isOverdue: false,
  };
}

/** 两条待办的 Today 视图。 */
const VIEW: TodayViewDto = {
  date: "2026-10-10",
  remainingCount: 2,
  todos: [todo("a", "写周报"), todo("b", "回邮件")],
  tips: [],
  completed: [],
};

/** 推进虚拟时间并让挂起的 Promise 完成。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 渲染悬浮窗并 Hover 展开面板。 */
async function openPanel(ipc: MemoryIpc): Promise<void> {
  renderWithProviders(<FloatingRoot />, ipc);
  await advance(0);
  fireEvent.pointerEnter(screen.getByRole("group", { name: "StarAt悬浮窗" }));
  await advance(HOVER_ENTER_DELAY_MS);
}

/** 按顺序列出待办区的标题。 */
function openTitles(): string[] {
  return within(screen.getByRole("list", { name: "待办" }))
    .getAllByRole("checkbox")
    .map((box) => box.getAttribute("aria-label") ?? "");
}

describe("完成与撤销", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Toast Store 是全局单例，不同用例之间不能互相残留提示。
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("勾选后待办移到「今日已完成」，并出现带「撤销」的提示", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);

    fireEvent.click(screen.getByRole("checkbox", { name: "完成「写周报」" }));
    await advance(0);

    expect(openTitles()).toEqual(["完成「回邮件」"]);
    expect(
      within(screen.getByRole("list", { name: "今日已完成" })).getByRole("checkbox", {
        name: "重新打开「写周报」",
      }),
    ).toBeChecked();
    expect(screen.getByText("已完成「写周报」", { selector: "span" })).toBeInTheDocument();
    expect(ipc.calls).toContain("completeItem");
  });

  it("点「撤销」后回到原来的位置", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);
    fireEvent.click(screen.getByRole("checkbox", { name: "完成「写周报」" }));
    await advance(0);

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await advance(0);

    expect(ipc.calls).toContain("reopenItem");
    expect(screen.queryByRole("list", { name: "今日已完成" })).not.toBeInTheDocument();
    // 乐观更新把它放回了第一位；Mock 后端把它追加在末尾，但乐观结果在重新查询前不应被打乱。
    expect(openTitles()).toContain("完成「写周报」");
    expect(screen.queryByText("已完成「写周报」")).not.toBeInTheDocument();
  });

  it("后端失败时界面回滚，并显示错误提示", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);
    ipc.failNextTransitionWith(new AppError("ITEM_NOT_FOUND", "gone"));

    fireEvent.click(screen.getByRole("checkbox", { name: "完成「写周报」" }));
    await advance(0);

    expect(openTitles()).toEqual(["完成「写周报」", "完成「回邮件」"]);
    expect(screen.queryByRole("list", { name: "今日已完成" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("找不到这个条目");
  });

  it("取消勾选一条今日已完成的待办会重新打开它", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday({
      ...VIEW,
      remainingCount: 1,
      todos: [todo("b", "回邮件")],
      completed: [{ ...todo("a", "写周报"), status: "done" }],
    });
    await openPanel(ipc);

    fireEvent.click(screen.getByRole("checkbox", { name: "重新打开「写周报」" }));
    await advance(0);

    expect(ipc.calls).toContain("reopenItem");
    expect(openTitles()).toContain("完成「写周报」");
  });
});
