import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayItemDto } from "@/lib/ipc";
import { EMPTY_TODAY, createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { FloatingRoot, PANEL_HEIGHT_PX, PANEL_WIDTH_PX } from "./FloatingRoot";
import { HOVER_ENTER_DELAY_MS, HOVER_LEAVE_DELAY_MS } from "./model/floating-machine";

/** 悬浮窗根元素（同时是徽标与面板的容器，展开 / 收起时都存在）。 */
function root(): HTMLElement {
  return screen.getByRole("group", { name: "拾序悬浮窗" });
}

/** 推进虚拟时间并让挂起的 Promise 完成。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 构造一个 Today 待办条目。 */
function todoDto(id: string, title: string, isOverdue: boolean): TodayItemDto {
  return {
    id,
    itemType: "todo",
    title,
    status: "open",
    priority: "none",
    scheduled: { date: "2026-10-10", time: null },
    due: null,
    isOverdue,
  };
}

/** 构造一个 Today 提示条目（带时间）。 */
function tipDto(id: string, title: string, time: string): TodayItemDto {
  return {
    id,
    itemType: "tip",
    title,
    status: "open",
    priority: "none",
    scheduled: { date: "2026-10-10", time },
    due: null,
    isOverdue: false,
  };
}

describe("FloatingRoot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Hover 延迟之后展开为面板，并请求 Rust 把窗口调整为面板大小", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS - 1);
    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();

    await advance(1);
    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
    expect(ipc.lastExpand).toEqual({ width: PANEL_WIDTH_PX, height: PANEL_HEIGHT_PX });
  });

  it("Hover 展开与收起期间不再发起业务数据 IPC：Today 只在启动时取一次，之后只有窗口几何命令", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);
    fireEvent.pointerLeave(root());
    await advance(HOVER_LEAVE_DELAY_MS);

    expect(ipc.calls).toEqual(["getToday", "expandFloating", "collapseFloating"]);
  });

  it("鼠标只是路过（展开前就离开）不会发起任何 IPC", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS - 100);
    fireEvent.pointerLeave(root());
    await advance(5000);

    expect(ipc.calls).toEqual(["getToday"]);
  });

  it("离开后延迟收起，再次进入会取消收起", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    fireEvent.pointerLeave(root());
    await advance(HOVER_LEAVE_DELAY_MS - 100);
    fireEvent.pointerEnter(root());
    await advance(5000);

    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
    expect(ipc.calls).toEqual(["getToday", "expandFloating"]);
  });

  it("面板收起后回到徽标", async () => {
    renderWithProviders(<FloatingRoot />, createMemoryIpc());
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);
    fireEvent.pointerLeave(root());
    await advance(HOVER_LEAVE_DELAY_MS);

    expect(screen.getByRole("button", { name: /打开拾序主窗口/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();
  });

  it("展开命令失败时弹出错误提示，不会崩溃", async () => {
    const ipc = createMemoryIpc();
    const failing = {
      ...ipc,
      expandFloating: () => Promise.reject(new Error("window gone")),
    };
    renderWithProviders(<FloatingRoot />, failing);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    await advance(0);

    expect(screen.getByRole("alert")).toHaveTextContent("出了点问题");
  });

  it("后端补发「指针已离开」时同样延迟收起（WebView 漏发 pointerleave 的兜底）", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    // DOM 没有 pointerleave，只有后端事件。
    act(() => ipc.emitFloatingPointerLeft());
    await advance(HOVER_LEAVE_DELAY_MS - 1);
    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
    await advance(1);

    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();
    expect(ipc.calls).toEqual(["getToday", "expandFloating", "collapseFloating"]);
  });

  it("补发离开之后指针又在窗口内移动，会取消收起", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    act(() => ipc.emitFloatingPointerLeft());
    await advance(HOVER_LEAVE_DELAY_MS - 100);
    fireEvent.pointerMove(root());
    await advance(5000);

    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
  });

  it("Today 在启动时取一次并缓存，Hover 展开多次也不会再次取数", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);

    for (let i = 0; i < 3; i += 1) {
      fireEvent.pointerEnter(root());
      await advance(HOVER_ENTER_DELAY_MS);
      fireEvent.pointerLeave(root());
      await advance(HOVER_LEAVE_DELAY_MS);
    }

    expect(ipc.calls.filter((call) => call === "getToday")).toHaveLength(1);
  });

  it("后端数据变更事件让缓存失效并重新取数，徽标数字随之更新", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday({ ...EMPTY_TODAY, remainingCount: 4 });
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);
    expect(screen.getByRole("button", { name: /今天还剩 4 项待办/ })).toBeInTheDocument();

    ipc.setToday({ ...EMPTY_TODAY, remainingCount: 3 });
    act(() => ipc.emitDataChange());
    await advance(0);

    expect(screen.getByRole("button", { name: /今天还剩 3 项待办/ })).toBeInTheDocument();
    expect(ipc.calls.filter((call) => call === "getToday")).toHaveLength(2);
  });

  it("Today 尚未加载完成时徽标显示占位而不是 0", () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    expect(screen.getByRole("button", { name: "打开拾序主窗口" })).toBeInTheDocument();
  });

  it("展开后面板显示 Today 的待办、提示与已完成", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday({
      ...EMPTY_TODAY,
      remainingCount: 1,
      todos: [todoDto("1", "修复登录超时", true)],
      tips: [tipDto("2", "提交周报", "15:00:00")],
      completed: [{ ...todoDto("3", "写周报", false), status: "done" }],
    });
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    expect(screen.getByText("修复登录超时")).toBeInTheDocument();
    expect(screen.getByText("逾期")).toBeInTheDocument();
    expect(screen.getByText("提交周报")).toBeInTheDocument();
    expect(screen.getByText("15:00")).toBeInTheDocument();
    expect(screen.getByText("写周报")).toBeInTheDocument();
    expect(screen.queryByText("今天还没有安排")).not.toBeInTheDocument();
  });

  it("没有任何事项时显示空状态", async () => {
    renderWithProviders(<FloatingRoot />, createMemoryIpc());
    await advance(0);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    expect(screen.getByText("今天还没有安排")).toBeInTheDocument();
  });
});
