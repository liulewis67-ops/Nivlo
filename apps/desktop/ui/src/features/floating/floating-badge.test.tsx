import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { FloatingBadge } from "./FloatingBadge";

/** 徽标按钮。 */
function badge(): HTMLElement {
  return screen.getByRole("button", { name: /打开拾序主窗口/ });
}

describe("FloatingBadge", () => {
  it("单击（没有明显移动）打开主窗口", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    await user.click(badge());

    expect(ipc.openMainCalls).toBe(1);
    expect(ipc.dragStarts).toBe(0);
  });

  it("按下后移动超过阈值请求开始拖动，且只请求一次", () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(badge(), { clientX: 12, clientY: 10 });
    expect(ipc.dragStarts).toBe(0);

    fireEvent.pointerMove(badge(), { clientX: 30, clientY: 10 });
    fireEvent.pointerMove(badge(), { clientX: 60, clientY: 10 });
    expect(ipc.dragStarts).toBe(1);
  });

  it("开始拖动时把按下的位置交给后端（让徽标保持在光标下），而不是跨过阈值时的位置", () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 18, clientY: 9 });
    fireEvent.pointerMove(badge(), { clientX: 40, clientY: 12 });

    expect(ipc.dragStarts).toBe(1);
    expect(ipc.lastDragGrab).toEqual({ x: 18, y: 9 });
  });

  it("拖动之后收到的 click 不会打开主窗口", () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(badge(), { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(badge(), { clientX: 40, clientY: 10 });
    fireEvent.click(badge());

    expect(ipc.openMainCalls).toBe(0);
  });

  it("拖动结束后再次单击恢复为打开主窗口", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(badge(), { clientX: 40, clientY: 10 });
    fireEvent.click(badge());

    await user.click(badge());
    expect(ipc.openMainCalls).toBe(1);
  });

  it("非左键按下不会开始手势", () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingBadge />, ipc);

    fireEvent.pointerDown(badge(), { button: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(badge(), { clientX: 80, clientY: 10 });

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
