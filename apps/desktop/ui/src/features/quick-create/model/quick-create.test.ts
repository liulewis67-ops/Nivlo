import { describe, expect, it } from "vitest";
import { canSubmit, cycleKind, normalizeTitle, resolveKey } from "./quick-create";

describe("normalizeTitle / canSubmit", () => {
  it("去除首尾空白", () => {
    expect(normalizeTitle("  写周报 \n")).toBe("写周报");
  });

  it("空文本与纯空白不能提交", () => {
    expect(canSubmit("")).toBe(false);
    expect(canSubmit("   \t\n")).toBe(false);
    expect(canSubmit(" a ")).toBe(true);
  });
});

describe("resolveKey", () => {
  it("Enter 在有标题时提交", () => {
    expect(resolveKey({ key: "Enter", isComposing: false, title: "写周报" })).toBe("submit");
  });

  it("Enter 在标题为空时什么都不做", () => {
    expect(resolveKey({ key: "Enter", isComposing: false, title: "   " })).toBe("none");
  });

  it("Escape 取消，即使标题为空", () => {
    expect(resolveKey({ key: "Escape", isComposing: false, title: "" })).toBe("cancel");
    expect(resolveKey({ key: "Escape", isComposing: false, title: "abc" })).toBe("cancel");
  });

  it("输入法组合期间的 Enter 与 Escape 都被忽略（拼音上屏不是提交）", () => {
    expect(resolveKey({ key: "Enter", isComposing: true, title: "xiezhoubao" })).toBe("none");
    expect(resolveKey({ key: "Escape", isComposing: true, title: "xie" })).toBe("none");
  });

  it("其他按键没有动作", () => {
    expect(resolveKey({ key: "a", isComposing: false, title: "a" })).toBe("none");
  });
});

describe("类型组与标准焦点遍历", () => {
  it("标题中的 Tab / Shift+Tab 不拦截；输入法组合期间也忽略", () => {
    expect(resolveKey({ key: "Tab", isComposing: false, title: "" })).toBe("none");
    expect(resolveKey({ key: "Tab", isComposing: false, title: "", shiftKey: true })).toBe("none");
    expect(resolveKey({ key: "Tab", isComposing: true, title: "" })).toBe("none");
  });

  it("cycleKind 在 待办 → 笔记 → 提示 之间循环", () => {
    expect(cycleKind("todo", false)).toBe("note");
    expect(cycleKind("note", false)).toBe("tip");
    expect(cycleKind("tip", false)).toBe("todo");
    expect(cycleKind("todo", true)).toBe("tip");
    expect(cycleKind("tip", true)).toBe("note");
  });
});
