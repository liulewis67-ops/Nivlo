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
function todo(id: string, title: string, isOverdue = false): TodayItemDto {
  return {
    id,
    itemType: "todo",
    title,
    brief: null,
    status: "open",
    priority: "none",
    scheduled: { date: isOverdue ? "2026-10-08" : "2026-10-10", time: null },
    due: null,
    isOverdue,
  };
}

/** 三条待办的 Today 视图（丙逾期）。 */
const VIEW: TodayViewDto = {
  date: "2026-10-10",
  remainingCount: 3,
  todos: [todo("a", "甲"), todo("b", "乙"), todo("c", "丙", true)],
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
  fireEvent.pointerEnter(screen.getByRole("group", { name: "AsterJot悬浮窗" }));
  await advance(HOVER_ENTER_DELAY_MS);
}

/** 待办区里还剩哪些标题（取自勾选框名称）。 */
function remaining(): string[] {
  const list = screen.queryByRole("list", { name: "待办" });
  if (list === null) return [];
  return within(list)
    .getAllByRole("checkbox")
    .map((box) => /「(.+)」/.exec(box.getAttribute("aria-label") ?? "")?.[1] ?? "");
}

/**
 * 打开某条待办的「⋯」菜单。
 *
 * 用键盘事件打开：Radix 菜单的触发依赖 PointerEvent，jsdom 不完整支持；
 * 且 Testing Library 的 `findBy` 在 Vitest 假计时器下不会自动推进时间，所以也不用它。
 */
async function openMenu(title: string): Promise<void> {
  fireEvent.keyDown(screen.getByRole("button", { name: `「${title}」的更多操作` }), {
    key: "Enter",
  });
  await advance(0);
}

/** 点开「⋯」菜单并选择某一项。 */
async function chooseFromMenu(title: string, label: string): Promise<void> {
  await openMenu(title);
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
  await advance(0);
}

describe("推迟", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("「⋯」菜单推迟到明天：立即从 Today 消失，并给出可撤销的提示", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);

    await chooseFromMenu("乙", "推迟到明天");

    expect(remaining()).toEqual(["甲", "丙"]);
    expect(ipc.reschedules).toEqual([{ id: "b", target: { kind: "tomorrow" } }]);
    expect(screen.getByText("「乙」已推迟到明天", { selector: "span" })).toBeInTheDocument();
  });

  it("焦点被还给之前的应用（窗口 blur）之后菜单仍然开着，照样能选", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);
    await openMenu("乙");

    // 和真机记录到的顺序一致：先是菜单元素失去焦点（relatedTarget 为空），再是窗口 blur。
    act(() => {
      const menu = screen.getByRole("menu");
      menu.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
      menu.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
      window.dispatchEvent(new FocusEvent("blur"));
    });
    await advance(0);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "推迟到明天" }));
    await advance(0);
    expect(ipc.reschedules).toEqual([{ id: "b", target: { kind: "tomorrow" } }]);
  });

  it("悬浮窗的菜单不模态：打开时页面其余部分仍响应指针（否则面板以为指针离开而收起）", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);
    await openMenu("乙");

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("逾期的待办多一个「移到今天」，普通待办没有", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);

    await openMenu("甲");
    expect(screen.getByRole("menuitem", { name: "推迟到明天" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "移到今天" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await advance(0);

    await openMenu("丙");
    expect(screen.getByRole("menuitem", { name: "移到今天" })).toBeInTheDocument();
  });

  it("撤销：精确恢复原计划，并按改期前的顺序重新保存", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);
    await chooseFromMenu("乙", "推迟到下周一");

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await advance(0);

    expect(ipc.reschedules[1]).toEqual({
      id: "b",
      target: { kind: "exact", scheduled: { date: "2026-10-10", time: null } },
    });
    expect(ipc.lastReorder).toEqual(["a", "b", "c"]);
    expect(remaining()).toContain("乙");
  });

  it("后端失败时回滚并显示错误提示", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);
    ipc.failNextTransitionWith(new AppError("ITEM_NOT_FOUND", "gone"));

    await chooseFromMenu("乙", "推迟到明天");

    expect(remaining()).toEqual(["甲", "乙", "丙"]);
    expect(screen.getByRole("alert")).toHaveTextContent("找不到这个条目");
  });
});
