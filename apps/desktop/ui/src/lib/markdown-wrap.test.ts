import { describe, expect, it } from "vitest";
import { toggleMarkdownWrap } from "./markdown-wrap";

describe("toggleMarkdownWrap", () => {
  it("给选中的文字加上标记，选区仍框住原来的文字", () => {
    expect(toggleMarkdownWrap("写 周报 了", 2, 4, "**")).toEqual({
      value: "写 **周报** 了",
      start: 4,
      end: 6,
    });
  });

  it("两边已经是这个标记时去掉（再按一次取消）", () => {
    expect(toggleMarkdownWrap("写 **周报** 了", 4, 6, "**")).toEqual({
      value: "写 周报 了",
      start: 2,
      end: 4,
    });
  });

  it("没选中文字时插入一对标记，光标在中间", () => {
    expect(toggleMarkdownWrap("ab", 1, 1, "*")).toEqual({ value: "a**b", start: 2, end: 2 });
  });

  it("在开头或结尾也不会越界", () => {
    expect(toggleMarkdownWrap("周报", 0, 2, "*")).toEqual({ value: "*周报*", start: 1, end: 3 });
    expect(toggleMarkdownWrap("*周报*", 1, 3, "*")).toEqual({ value: "周报", start: 0, end: 2 });
  });
});
