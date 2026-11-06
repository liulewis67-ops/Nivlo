import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodayItemDto } from "@/lib/ipc";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { FloatingBadge } from "./FloatingBadge";
import { LONG_PRESS_MS } from "./model/drag-intent";

/** 徽标按钮。 */
function badge(): HTMLElement {
  return screen.getByRole("button", { name: /打开拾序主窗口/ });
}

/** 按住到长按计时结束，徽标进入选中态。 */
function holdLongPress(): void {
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS);
  });
}

/** 按住左键时的移动（`buttons: 1`；没有按键的移动会被当作已经松开）。 */
function drag(target: HTMLElement, init: Record<string, number>): void {
  fireEvent.pointerMove(target, { buttons: 1, ...init });
}

/** 构造一个已完成的待办。 */
function doneTodo(id: string): TodayItemDto {
  return {
    id,
    itemType: "todo",
    title: id,
    brief: null,
    status: "done",
    priority: "none",
    scheduled: { date: "2026-10-10", time: null },
    due: null,
    isOverdue: false,
  };
}

describe("FloatingBadge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("按下后捕获指针，在原生拖动交接、松开和取消时释放", () => {
    vi.useFakeTimers();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);
    const button = badge();
    let captured = false;
    const capture = vi.fn(() => {
      captured = true;
    });
    const release = vi.fn(() => {
      captured = false;
    });
    Object.assign(button, {
      setPointerCapture: capture,
      hasPointerCapture: () => captured,
      releasePointerCapture: release,
    });
    fireEvent.pointerDown(button, { button: 0, pointerId: 7, clientX: 32, clientY: 16 });
    expect(capture).toHaveBeenCalledWith(7);
    holdLongPress();
    drag(button, { pointerId: 7, clientX: -20, clientY: 16 });
    expect(ipc.dragStarts).toBe(1);
    expect(captured).toBe(false);
    expect(release).toHaveBeenCalledWith(7);

    fireEvent.pointerDown(button, { button: 0, pointerId: 8, clientX: 32, clientY: 16 });
    fireEvent.pointerUp(button, { pointerId: 8 });
    expect(captured).toBe(false);
    fireEvent.pointerDown(button, { button: 0, pointerId: 9, clientX: 32, clientY: 16 });
    fireEvent.pointerCancel(button, { pointerId: 9 });
    expect(captured).toBe(false);
    expect(release).toHaveBeenCalledTimes(3);
    drag(button, { pointerId: 9, clientX: -100, clientY: 16 });
    expect(ipc.dragStarts).toBe(1);
  });

  it("显示剩余数量；全部完成时改为「都做完了」的对勾", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday({
      date: "2026-10-10",
      remainingCount: 0,
      todos: [],
      tips: [],
      completed: [doneTodo("a"), doneTodo("b")],
    });
    renderWithProviders(<FloatingBadge />, ipc);

    expect(await screen.findByRole("button", { name: /今天的事都做完了/ })).toHaveAttribute(
      "data-done",
      "true",
    );
  });

  it("右键不弹系统菜单，而是快速添加待办", () => {
    const ipc = createMemoryIpc();
    const onQuickAdd = vi.fn();
    renderWithProviders(<FloatingBadge onQuickAdd={onQuickAdd} />, ipc);

    const prevented = !fireEvent.contextMenu(badge());

    expect(prevented).toBe(true);
    expect(onQuickAdd).toHaveBeenCalledTimes(1);
    expect(ipc.openMainCalls).toBe(0);
  });

  it("单击（没有明显移动）打开主窗口", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    await user.click(badge());

    expect(ipc.openMainCalls).toBe(1);
    expect(ipc.dragStarts).toBe(0);
  });

  it("长按选中后移动超过阈值请求开始拖动，且只请求一次", () => {
    vi.useFakeTimers();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 10, clientY: 10 });
    expect(badge()).not.toHaveAttribute("data-selected");
    holdLongPress();
    expect(badge()).toHaveAttribute("data-selected", "true");

    drag(badge(), { clientX: 12, clientY: 10 });
    expect(ipc.dragStarts).toBe(0);
    drag(badge(), { clientX: 30, clientY: 10 });
    drag(badge(), { clientX: 60, clientY: 10 });
    expect(ipc.dragStarts).toBe(1);
  });

  it("没有长按就移动不会拖动，也不会打开主窗口", () => {
    vi.useFakeTimers();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 10, clientY: 10 });
    drag(badge(), { clientX: 40, clientY: 10 });
    // 移动之后再按满长按时间也不会选中：这次手势已经放弃了。
    holdLongPress();
    drag(badge(), { clientX: 80, clientY: 10 });
    fireEvent.pointerUp(badge(), { clientX: 80, clientY: 10 });
    fireEvent.click(badge());

    expect(badge()).not.toHaveAttribute("data-selected");
    expect(ipc.dragStarts).toBe(0);
    expect(ipc.openMainCalls).toBe(0);
  });

  it("长按后不移动直接松开只是取消选中，不打开主窗口", () => {
    vi.useFakeTimers();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 10, clientY: 10 });
    holdLongPress();
    fireEvent.pointerUp(badge(), { clientX: 10, clientY: 10 });
    fireEvent.click(badge());

    expect(badge()).not.toHaveAttribute("data-selected");
    expect(ipc.openMainCalls).toBe(0);
  });

  it("原生拖动结束后（收不到 pointerup）第一次无按键的移动取消选中", () => {
    vi.useFakeTimers();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 10, clientY: 10 });
    holdLongPress();
    drag(badge(), { clientX: 40, clientY: 10 });
    expect(badge()).toHaveAttribute("data-selected", "true");

    fireEvent.pointerMove(badge(), { buttons: 0, clientX: 12, clientY: 10 });
    expect(badge()).not.toHaveAttribute("data-selected");
  });

  it("开始拖动时把按下的位置交给后端（让徽标保持在光标下），而不是跨过阈值时的位置", () => {
    vi.useFakeTimers();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 18, clientY: 9 });
    holdLongPress();
    drag(badge(), { clientX: 40, clientY: 12 });

    expect(ipc.dragStarts).toBe(1);
    expect(ipc.lastDragGrab).toEqual({ x: 18, y: 9 });
  });

  it("拖动之后收到的 click 不会打开主窗口", () => {
    vi.useFakeTimers();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 10, clientY: 10 });
    holdLongPress();
    drag(badge(), { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(badge(), { clientX: 40, clientY: 10 });
    fireEvent.click(badge());

    expect(ipc.dragStarts).toBe(1);
    expect(ipc.openMainCalls).toBe(0);
  });

  it("拖动结束后再次单击恢复为打开主窗口", async () => {
    vi.useFakeTimers();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 10, clientY: 10 });
    holdLongPress();
    drag(badge(), { clientX: 40, clientY: 10 });
    fireEvent.click(badge());
    vi.useRealTimers();

    const user = userEvent.setup();
    await user.click(badge());
    expect(ipc.openMainCalls).toBe(1);
  });

  it("单击很快松开不会进入选中态", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    await user.click(badge());
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50));

    expect(badge()).not.toHaveAttribute("data-selected");
    expect(ipc.openMainCalls).toBe(1);
  });

  it("非左键按下不会开始手势", () => {
    vi.useFakeTimers();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 2, clientX: 10, clientY: 10 });
    holdLongPress();
    drag(badge(), { clientX: 80, clientY: 10 });

    expect(ipc.dragStarts).toBe(0);
  });

  it("键盘激活同样打开主窗口", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    await user.tab();
    await user.keyboard("{Enter}");

    expect(ipc.openMainCalls).toBe(1);
  });
});
