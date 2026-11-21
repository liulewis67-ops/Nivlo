import { describe, expect, it } from "vitest";
import { isCommandKey, isDialogOpen, isTyping } from "./typing";

/** 构造按键。 */
function key(name: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
  return {
    key: name,
    ctrlKey: modifiers.ctrl ?? false,
    metaKey: false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
  };
}

describe("键盘工具", () => {
  it("isCommandKey：只认 Ctrl + 那个键，不区分大小写，带 Alt / Shift 不算", () => {
    expect(isCommandKey(key("n", { ctrl: true }), "n")).toBe(true);
    expect(isCommandKey(key("N", { ctrl: true }), "n")).toBe(true);
    expect(isCommandKey(key("n"), "n")).toBe(false);
    expect(isCommandKey(key("n", { ctrl: true, shift: true }), "n")).toBe(false);
    expect(isCommandKey(key("n", { ctrl: true, alt: true }), "n")).toBe(false);
    expect(isCommandKey(key("m", { ctrl: true }), "n")).toBe(false);
  });

  it("isTyping 认出输入框与可编辑内容；isDialogOpen 认出模态对话框", () => {
    const input = document.createElement("input");
    const button = document.createElement("button");
    expect(isTyping({ target: input })).toBe(true);
    expect(isTyping({ target: button })).toBe(false);
    expect(isTyping({ target: null })).toBe(false);

    expect(isDialogOpen()).toBe(false);
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    expect(isDialogOpen()).toBe(true);
    dialog.remove();
  });
});
