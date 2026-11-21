import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { TodayPanel } from "./TodayPanel";
import { LONG_PRESS_MS } from "./model/drag-intent";

/** 渲染展开的面板。 */
function renderPanel() {
  const ipc = createMemoryIpc();
  renderWithProviders(
    <TodayPanel
      layout={null}
      quickCreateKind={null}
      onQuickCreate={() => {}}
      onQuickCreateKindChange={() => {}}
      onQuickCreateDone={() => {}}
    />,
    ipc,
  );
  const panel = screen.getByRole("region");
  const title = panel.querySelector("h2");
  if (title === null) throw new Error("面板没有标题");
  return { ipc, panel, title };
}

/** 按住到长按计时结束。 */
function holdLongPress(): void {
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS);
  });
}

describe("长按面板拖动悬浮窗", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("长按面板标题拿起，移动后请求开始拖动，且只请求一次", () => {
    vi.useFakeTimers();
    const { ipc, panel, title } = renderPanel();

    fireEvent.pointerDown(title, { button: 0, clientX: 40, clientY: 20 });
    expect(panel).not.toHaveAttribute("data-grabbed");
    holdLongPress();
    expect(panel).toHaveAttribute("data-grabbed", "true");

    fireEvent.pointerMove(title, { buttons: 1, clientX: 60, clientY: 20 });
    fireEvent.pointerMove(title, { buttons: 1, clientX: 90, clientY: 20 });
    expect(ipc.dragStarts).toBe(1);
  });

  it("没有长按就移动不会拖动", () => {
    vi.useFakeTimers();
    const { ipc, title } = renderPanel();

    fireEvent.pointerDown(title, { button: 0, clientX: 40, clientY: 20 });
    fireEvent.pointerMove(title, { buttons: 1, clientX: 80, clientY: 20 });
    holdLongPress();
    fireEvent.pointerMove(title, { buttons: 1, clientX: 120, clientY: 20 });
    expect(ipc.dragStarts).toBe(0);
  });

  it("按在按钮上长按不会拿起面板", () => {
    vi.useFakeTimers();
    const { ipc, panel } = renderPanel();
    const button = screen.getAllByRole("button")[0];
    if (button === undefined) throw new Error("面板没有按钮");

    fireEvent.pointerDown(button, { button: 0, clientX: 40, clientY: 20 });
    holdLongPress();
    expect(panel).not.toHaveAttribute("data-grabbed");
    fireEvent.pointerMove(button, { buttons: 1, clientX: 90, clientY: 20 });
    expect(ipc.dragStarts).toBe(0);
  });
});
