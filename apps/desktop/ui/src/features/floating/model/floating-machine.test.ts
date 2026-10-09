import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOVER_ENTER_DELAY_MS,
  HOVER_LEAVE_DELAY_MS,
  createFloatingMachine,
  needsPanelWindow,
} from "./floating-machine";
import type { FloatingMachine } from "./floating-machine";

describe("createFloatingMachine", () => {
  let machine: FloatingMachine;

  beforeEach(() => {
    vi.useFakeTimers();
    machine = createFloatingMachine();
  });

  afterEach(() => {
    machine.dispose();
    vi.useRealTimers();
  });

  describe("hover 展开 / 收起", () => {
    it("初始是收起态", () => {
      expect(machine.getState()).toBe("collapsed");
    });

    it("指针进入后等待延迟才展开，而不是立刻展开", () => {
      machine.send("pointerEnter");
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS - 1);
      expect(machine.getState()).toBe("collapsed");
      vi.advanceTimersByTime(1);
      expect(machine.getState()).toBe("expanded");
    });

    it("指针在展开前离开会取消展开（鼠标只是路过）", () => {
      machine.send("pointerEnter");
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS - 50);
      machine.send("pointerLeave");
      vi.advanceTimersByTime(1000);
      expect(machine.getState()).toBe("collapsed");
    });

    it("指针离开后等待延迟才收起", () => {
      machine.send("pointerEnter");
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS);
      machine.send("pointerLeave");
      vi.advanceTimersByTime(HOVER_LEAVE_DELAY_MS - 1);
      expect(machine.getState()).toBe("expanded");
      vi.advanceTimersByTime(1);
      expect(machine.getState()).toBe("collapsed");
    });

    it("在收起之前重新进入会取消收起（Hover Safe Area：路径上不闪烁）", () => {
      machine.send("pointerEnter");
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS);
      machine.send("pointerLeave");
      vi.advanceTimersByTime(HOVER_LEAVE_DELAY_MS - 100);
      machine.send("pointerEnter");
      vi.advanceTimersByTime(5000);
      expect(machine.getState()).toBe("expanded");
    });

    it("重复的 pointerEnter 不会重置展开计时器", () => {
      machine.send("pointerEnter");
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS - 100);
      machine.send("pointerEnter");
      vi.advanceTimersByTime(100);
      expect(machine.getState()).toBe("expanded");
    });

    it("使用自定义延迟", () => {
      const fast = createFloatingMachine({ enterDelayMs: 10, leaveDelayMs: 20 });
      fast.send("pointerEnter");
      vi.advanceTimersByTime(10);
      expect(fast.getState()).toBe("expanded");
      fast.send("pointerLeave");
      vi.advanceTimersByTime(20);
      expect(fast.getState()).toBe("collapsed");
    });
  });

  describe("Quick Create", () => {
    /** 把状态机推进到展开态。 */
    function expand(): void {
      machine.send("pointerEnter");
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS);
    }

    it("从展开态进入，输入期间指针离开不会收起", () => {
      expand();
      machine.send("quickCreateRequested");
      expect(machine.getState()).toBe("quickCreate");
      machine.send("pointerLeave");
      vi.advanceTimersByTime(10_000);
      expect(machine.getState()).toBe("quickCreate");
    });

    it("可以从收起态直接进入（全局快捷键呼出）", () => {
      machine.send("quickCreateRequested");
      expect(machine.getState()).toBe("quickCreate");
    });

    it("结束后回到展开态；指针仍在窗口内则保持展开", () => {
      expand();
      machine.send("quickCreateRequested");
      machine.send("quickCreateFinished");
      expect(machine.getState()).toBe("expanded");
      vi.advanceTimersByTime(10_000);
      expect(machine.getState()).toBe("expanded");
    });

    it("结束时指针已经离开：先展开态，延迟后收起，而不是瞬间消失", () => {
      expand();
      machine.send("quickCreateRequested");
      machine.send("pointerLeave");
      machine.send("quickCreateFinished");
      expect(machine.getState()).toBe("expanded");
      vi.advanceTimersByTime(HOVER_LEAVE_DELAY_MS);
      expect(machine.getState()).toBe("collapsed");
    });

    it("不在 Quick Create 时 quickCreateFinished 没有效果", () => {
      machine.send("quickCreateFinished");
      expect(machine.getState()).toBe("collapsed");
    });
  });

  describe("拖放悬停", () => {
    it("拖入立刻进入 DragHover，没有延迟", () => {
      machine.send("dragEnter");
      expect(machine.getState()).toBe("dragHover");
    });

    it("拖入会取消待执行的展开", () => {
      machine.send("pointerEnter");
      machine.send("dragEnter");
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS * 2);
      expect(machine.getState()).toBe("dragHover");
    });

    it("从收起态拖入，离开后回到收起态", () => {
      machine.send("dragEnter");
      machine.send("dragLeave");
      expect(machine.getState()).toBe("collapsed");
    });

    it("从展开态拖入，指针仍在内时离开拖放回到展开态", () => {
      machine.send("pointerEnter");
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS);
      machine.send("dragEnter");
      machine.send("dropped");
      expect(machine.getState()).toBe("expanded");
    });

    it("从展开态拖入、指针已离开：回到展开态后延迟收起", () => {
      machine.send("pointerEnter");
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS);
      machine.send("dragEnter");
      machine.send("pointerLeave");
      machine.send("dragLeave");
      expect(machine.getState()).toBe("expanded");
      vi.advanceTimersByTime(HOVER_LEAVE_DELAY_MS);
      expect(machine.getState()).toBe("collapsed");
    });

    it("Quick Create 期间的拖入被忽略", () => {
      machine.send("quickCreateRequested");
      machine.send("dragEnter");
      expect(machine.getState()).toBe("quickCreate");
    });

    it("DragHover 期间的 pointerEnter / pointerLeave 不改变状态", () => {
      machine.send("dragEnter");
      machine.send("pointerEnter");
      machine.send("pointerLeave");
      vi.advanceTimersByTime(5000);
      expect(machine.getState()).toBe("dragHover");
    });
  });

  describe("订阅与清理", () => {
    it("状态变化时通知订阅者，没有变化时不通知，取消订阅后不再通知", () => {
      const listener = vi.fn();
      const unsubscribe = machine.subscribe(listener);
      machine.send("pointerEnter");
      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      machine.send("quickCreateRequested");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("dispose 清除所有计时器，且之后仍可继续使用", () => {
      machine.send("pointerEnter");
      machine.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(machine.getState()).toBe("collapsed");

      machine.send("pointerEnter");
      vi.advanceTimersByTime(HOVER_ENTER_DELAY_MS);
      expect(machine.getState()).toBe("expanded");
    });

    it("空闲的收起态没有任何待执行的计时器", () => {
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("needsPanelWindow", () => {
    it("只有收起态不需要面板窗口", () => {
      expect(needsPanelWindow("collapsed")).toBe(false);
      expect(needsPanelWindow("expanded")).toBe(true);
      expect(needsPanelWindow("quickCreate")).toBe(true);
      expect(needsPanelWindow("dragHover")).toBe(true);
    });
  });
});
