import { describe, expect, it } from "vitest";
import { captureAccelerator } from "./accelerator";
import type { KeyEventLike } from "./accelerator";

/** 构造按键事件，默认没有修饰键。 */
function press(code: string, key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    code,
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  };
}

describe("captureAccelerator", () => {
  it("修饰键 + 主键 → 规范文本（修饰键顺序固定）", () => {
    expect(captureAccelerator(press("Space", " ", { shiftKey: true, ctrlKey: true }))).toEqual({
      kind: "accelerator",
      text: "Ctrl+Shift+Space",
    });
    expect(captureAccelerator(press("KeyQ", "q", { altKey: true, ctrlKey: true }))).toEqual({
      kind: "accelerator",
      text: "Ctrl+Alt+Q",
    });
  });

  it("用物理按键：Shift 改变 key（5 → %）也不影响主键", () => {
    expect(captureAccelerator(press("Digit5", "%", { ctrlKey: true, shiftKey: true }))).toEqual({
      kind: "accelerator",
      text: "Ctrl+Shift+5",
    });
  });

  it("功能键、方向键、Win 键", () => {
    expect(captureAccelerator(press("F12", "F12", { ctrlKey: true }))).toEqual({
      kind: "accelerator",
      text: "Ctrl+F12",
    });
    expect(captureAccelerator(press("ArrowLeft", "ArrowLeft", { metaKey: true }))).toEqual({
      kind: "accelerator",
      text: "Win+Left",
    });
  });

  it("只按了修饰键：还没完成，继续等待", () => {
    expect(captureAccelerator(press("ControlLeft", "Control", { ctrlKey: true }))).toEqual({
      kind: "incomplete",
    });
    expect(captureAccelerator(press("ShiftRight", "Shift", { shiftKey: true }))).toEqual({
      kind: "incomplete",
    });
  });

  it("没有修饰键的单个按键不可用（会吞掉正常输入）", () => {
    expect(captureAccelerator(press("Space", " "))).toEqual({
      kind: "unusable",
      reason: "noModifier",
    });
    expect(captureAccelerator(press("KeyA", "a"))).toEqual({
      kind: "unusable",
      reason: "noModifier",
    });
  });

  it("不支持的按键（如标点、F25）不可用", () => {
    expect(captureAccelerator(press("Comma", ",", { ctrlKey: true }))).toEqual({
      kind: "unusable",
      reason: "unsupportedKey",
    });
    expect(captureAccelerator(press("F25", "F25", { ctrlKey: true })).kind).toBe("unusable");
  });
});
