import { describe, expect, it } from "vitest";
import { DRAG_THRESHOLD_PX, createDragIntentTracker } from "./drag-intent";

describe("createDragIntentTracker", () => {
  it("没有移动就抬起是一次点击", () => {
    const tracker = createDragIntentTracker();
    tracker.press({ x: 10, y: 10 });
    expect(tracker.release()).toBe("click");
    expect(tracker.phase).toBe("idle");
  });

  it("移动小于阈值仍然是点击（手抖不算移动）", () => {
    const tracker = createDragIntentTracker();
    tracker.press({ x: 10, y: 10 });
    expect(tracker.move({ x: 12, y: 11 })).toBe(false);
    expect(tracker.release()).toBe("click");
  });

  it("没有长按就移动超过阈值：放弃本次手势，既不拖动也不是点击", () => {
    const tracker = createDragIntentTracker();
    tracker.press({ x: 0, y: 0 });
    expect(tracker.move({ x: DRAG_THRESHOLD_PX, y: 0 })).toBe(false);
    expect(tracker.phase).toBe("abandoned");
    // 放弃之后到点的长按与继续移动都不再生效。
    expect(tracker.select()).toBe(false);
    expect(tracker.move({ x: 50, y: 50 })).toBe(false);
    expect(tracker.release()).toBe("none");
  });

  it("长按选中后移动达到阈值时刚好触发一次拖动开始", () => {
    const tracker = createDragIntentTracker();
    tracker.press({ x: 0, y: 0 });
    expect(tracker.select()).toBe(true);
    expect(tracker.phase).toBe("selected");
    expect(tracker.move({ x: 2, y: 0 })).toBe(false);
    expect(tracker.move({ x: DRAG_THRESHOLD_PX, y: 0 })).toBe(true);
    expect(tracker.phase).toBe("dragging");
    // 之后继续移动不会再次触发。
    expect(tracker.move({ x: 50, y: 50 })).toBe(false);
    expect(tracker.release()).toBe("drag");
  });

  it("长按后不移动就松开不算点击", () => {
    const tracker = createDragIntentTracker();
    tracker.press({ x: 0, y: 0 });
    tracker.select();
    expect(tracker.release()).toBe("none");
  });

  it("没有按下时长按、移动与抬起都没有效果", () => {
    const tracker = createDragIntentTracker();
    expect(tracker.select()).toBe(false);
    expect(tracker.move({ x: 100, y: 100 })).toBe(false);
    expect(tracker.release()).toBe("none");
  });

  it("按斜线距离而不是单轴距离判断阈值", () => {
    const tracker = createDragIntentTracker();
    tracker.press({ x: 0, y: 0 });
    tracker.select();
    // 3 和 3 的单轴都小于 4，但斜线距离约 4.24。
    expect(tracker.move({ x: 3, y: 3 })).toBe(true);
  });

  it("取消后回到空闲，下一次手势重新计算", () => {
    const tracker = createDragIntentTracker();
    tracker.press({ x: 0, y: 0 });
    tracker.move({ x: 20, y: 0 });
    tracker.cancel();
    expect(tracker.phase).toBe("idle");

    tracker.press({ x: 100, y: 100 });
    expect(tracker.release()).toBe("click");
  });

  it("支持自定义阈值", () => {
    const tracker = createDragIntentTracker(10);
    tracker.press({ x: 0, y: 0 });
    tracker.select();
    expect(tracker.move({ x: 9, y: 0 })).toBe(false);
    expect(tracker.move({ x: 10, y: 0 })).toBe(true);
  });
});
