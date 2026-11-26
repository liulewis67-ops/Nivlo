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

/** 每行的高度（px）：jsdom 没有布局，需要手工提供让 dnd-kit 能算出相邻关系。 */
const ROW_HEIGHT = 30;

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

/** 三条待办的 Today 视图。 */
const VIEW: TodayViewDto = {
  date: "2026-10-10",
  remainingCount: 3,
  todos: [todo("a", "甲"), todo("b", "乙"), todo("c", "丙")],
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
  fireEvent.pointerEnter(screen.getByRole("group", { name: "StarDeskBox悬浮窗" }));
  await advance(HOVER_ENTER_DELAY_MS);
}

/** 当前待办区的标题顺序（取自拖拽手柄的名称）。 */
function order(): string[] {
  return within(screen.getByRole("list", { name: "待办" }))
    .getAllByRole("button", { name: /拖动以调整/ })
    .map((handle) => /「(.+)」/.exec(handle.getAttribute("aria-label") ?? "")?.[1] ?? "");
}

/** 用键盘把 `title` 那一行向下移动一位：Space 拿起 → ↓ → Space 放下。 */
async function moveDown(title: string): Promise<void> {
  const handle = screen.getByRole("button", { name: `拖动以调整「${title}」的顺序` });
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await advance(0);
  fireEvent.keyDown(handle, { code: "ArrowDown", key: "ArrowDown" });
  await advance(0);
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await advance(0);
}

describe("Today 排序", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
    // 让每个 <li> 按它在列表中的下标垂直排布。
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const row = this.closest("li");
      const index = row === null ? 0 : Array.from(row.parentElement?.children ?? []).indexOf(row);
      const top = this.tagName === "LI" || row !== null ? index * ROW_HEIGHT : 0;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 200,
        bottom: top + ROW_HEIGHT,
        width: 200,
        height: ROW_HEIGHT,
        toJSON: () => ({}),
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("每一行都有可聚焦的拖拽手柄", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);

    expect(order()).toEqual(["甲", "乙", "丙"]);
  });

  it("键盘排序：立即落位，并把完整顺序交给后端保存", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);

    await moveDown("甲");

    expect(order()).toEqual(["乙", "甲", "丙"]);
    expect(ipc.lastReorder).toEqual(["b", "a", "c"]);
  });

  it("保存失败时恢复原顺序并提示错误", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await openPanel(ipc);
    ipc.failNextTransitionWith(new AppError("STORAGE_UNAVAILABLE", "down"));

    await moveDown("甲");

    expect(order()).toEqual(["甲", "乙", "丙"]);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
