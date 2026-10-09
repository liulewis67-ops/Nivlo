import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryIpc } from "@/test/ipc-mock";
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

  it("Hover 展开与收起期间不发起任何业务数据的 IPC，只有窗口几何命令", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);
    fireEvent.pointerLeave(root());
    await advance(HOVER_LEAVE_DELAY_MS);

    expect(ipc.calls).toEqual(["expandFloating", "collapseFloating"]);
  });

  it("鼠标只是路过（展开前就离开）不会发起任何 IPC", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS - 100);
    fireEvent.pointerLeave(root());
    await advance(5000);

    expect(ipc.calls).toEqual([]);
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
    expect(ipc.calls).toEqual(["expandFloating"]);
  });

  it("面板收起后回到徽标", async () => {
    renderWithProviders(<FloatingRoot />, createMemoryIpc());
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);
    fireEvent.pointerLeave(root());
    await advance(HOVER_LEAVE_DELAY_MS);

    expect(screen.getByRole("button", { name: "打开拾序主窗口" })).toBeInTheDocument();
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
    expect(ipc.calls).toEqual(["expandFloating", "collapseFloating"]);
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
});
