import { describe, expect, it } from "vitest";
import { resolveAnimationSlot, stepFrame } from "./frame-timeline";

describe("resolveAnimationSlot", () => {
  it("applies priority reminder > grabbed > ready > done > hover > idle", () => {
    expect(resolveAnimationSlot({})).toBe("idle");
    expect(resolveAnimationSlot({ hovered: true })).toBe("hover");
    expect(resolveAnimationSlot({ hovered: true, done: true })).toBe("done");
    expect(resolveAnimationSlot({ hovered: true, done: true, ready: true })).toBe("ready");
    expect(resolveAnimationSlot({ ready: true, grabbed: true })).toBe("grabbed");
    expect(resolveAnimationSlot({ grabbed: true, reminder: true })).toBe("reminder");
  });
});

describe("stepFrame", () => {
  it("loops and never finishes", () => {
    expect(stepFrame(2, 3, "loop", 1)).toEqual({ index: 0, direction: 1, finished: false });
  });

  it("plays once and stops on the last frame", () => {
    expect(stepFrame(0, 3, "once", 1)).toEqual({ index: 1, direction: 1, finished: false });
    expect(stepFrame(1, 3, "once", 1)).toEqual({ index: 2, direction: 1, finished: false });
    expect(stepFrame(2, 3, "once", 1)).toEqual({ index: 2, direction: 1, finished: true });
  });

  it("ping-pongs back and forth", () => {
    let state = { index: 0, direction: 1 as 1 | -1, finished: false };
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      state = stepFrame(state.index, 3, "pingpong", state.direction);
      seen.push(state.index);
    }
    expect(seen).toEqual([1, 2, 1, 0, 1, 2]);
  });

  it("stays on frame 0 when still or single-frame", () => {
    expect(stepFrame(1, 3, "still", 1)).toEqual({ index: 0, direction: 1, finished: true });
    expect(stepFrame(0, 1, "loop", 1)).toEqual({ index: 0, direction: 1, finished: true });
  });
});
