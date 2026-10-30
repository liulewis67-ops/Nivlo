import { describe, expect, it } from "vitest";
import {
  continueMarkdownList,
  indentMarkdownList,
  linkOnPaste,
  toggleMarkdownTask,
  toggleMarkdownWrap,
} from "./markdown-wrap";

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

describe("continueMarkdownList", () => {
  /** 在全文末尾按 Enter。 */
  function enterAtEnd(value: string) {
    return continueMarkdownList(value, value.length, value.length)?.value ?? null;
  }

  it("无序、有序、任务列表：下一行带上记号", () => {
    expect(enterAtEnd("- 买牛奶")).toBe("- 买牛奶\n- ");
    expect(enterAtEnd("  * 子项")).toBe("  * 子项\n  * ");
    expect(enterAtEnd("9. 第九")).toBe("9. 第九\n10. ");
    expect(enterAtEnd("- [x] 做完的")).toBe("- [x] 做完的\n- [ ] ");
  });

  it("空的一项按 Enter 结束列表", () => {
    expect(enterAtEnd("- 买牛奶\n- ")).toBe("- 买牛奶\n");
  });

  it("光标不在行尾、选中了文字或不是列表时按普通换行", () => {
    expect(continueMarkdownList("- 买牛奶", 3, 3)).toBeNull();
    expect(continueMarkdownList("- 买牛奶", 2, 5)).toBeNull();
    expect(enterAtEnd("普通的一行")).toBeNull();
  });

  it("在中间某一行的末尾也生效，光标落在新记号之后", () => {
    expect(continueMarkdownList("- 一\n- 二", 3, 3)).toEqual({
      value: "- 一\n- \n- 二",
      start: 6,
      end: 6,
    });
  });
});

describe("indentMarkdownList", () => {
  it("Tab 缩进光标所在的列表项，光标跟着移动", () => {
    expect(indentMarkdownList("- 一\n- 二", 7, 7, false)).toEqual({
      value: "- 一\n  - 二",
      start: 9,
      end: 9,
    });
  });

  it("Shift+Tab 取消缩进，最多两个空格，没有缩进时不变", () => {
    expect(indentMarkdownList("  - 二", 4, 4, true)).toEqual({ value: "- 二", start: 2, end: 2 });
    expect(indentMarkdownList("- 二", 2, 2, true)).toEqual({ value: "- 二", start: 2, end: 2 });
  });

  it("选中多行时只动其中的列表项", () => {
    expect(indentMarkdownList("标题\n- 一\n- 二", 0, 10, false)?.value).toBe(
      "标题\n  - 一\n  - 二",
    );
  });

  it("不在列表里时返回 null，Tab 照常移走焦点", () => {
    expect(indentMarkdownList("普通的一行", 2, 2, false)).toBeNull();
  });
});

describe("toggleMarkdownTask", () => {
  it("勾选光标所在的任务项，再按一次取消", () => {
    expect(toggleMarkdownTask("- [ ] 买牛奶", 8, 8)?.value).toBe("- [x] 买牛奶");
    expect(toggleMarkdownTask("- [x] 买牛奶", 8, 8)?.value).toBe("- [ ] 买牛奶");
    expect(toggleMarkdownTask("1. [X] 第一", 3, 3)?.value).toBe("1. [ ] 第一");
  });

  it("多行里有没勾的就全部勾上；不是任务项的行不动", () => {
    expect(toggleMarkdownTask("- [x] 一\n说明\n- [ ] 二", 0, 16)?.value).toBe(
      "- [x] 一\n说明\n- [x] 二",
    );
  });

  it("没有任务项时返回 null", () => {
    expect(toggleMarkdownTask("- 普通列表", 2, 2)).toBeNull();
  });
});

describe("linkOnPaste", () => {
  it("选中文字粘贴网址变成链接，光标在链接之后", () => {
    expect(linkOnPaste("看 文档 吧", 2, 4, " https://example.com/a ")).toEqual({
      value: "看 [文档](https://example.com/a) 吧",
      start: 29,
      end: 29,
    });
  });

  it("没选中、不是网址、选中的本身是网址或跨行时按普通粘贴", () => {
    expect(linkOnPaste("文档", 1, 1, "https://example.com")).toBeNull();
    expect(linkOnPaste("文档", 0, 2, "随便一段话")).toBeNull();
    expect(linkOnPaste("文档", 0, 2, "https://a.com https://b.com")).toBeNull();
    expect(linkOnPaste("https://old.com", 0, 15, "https://new.com")).toBeNull();
    expect(linkOnPaste("一\n二", 0, 3, "https://example.com")).toBeNull();
  });
});
