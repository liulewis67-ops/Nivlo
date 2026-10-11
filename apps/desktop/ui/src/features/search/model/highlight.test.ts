import { describe, expect, it } from "vitest";
import { highlight, searchTerms, snippetAround } from "./highlight";

describe("searchTerms", () => {
  it("按空白拆分、小写、去重", () => {
    expect(searchTerms("  Fix  LOGIN fix ")).toEqual(["fix", "login"]);
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("highlight", () => {
  it("切成命中与未命中片段，拼起来等于原文", () => {
    const segments = highlight("修复登录超时，登录失败", ["登录"]);
    expect(segments.map((s) => s.text).join("")).toBe("修复登录超时，登录失败");
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(["登录", "登录"]);
    expect(segments[0]).toEqual({ text: "修复", match: false });
  });

  it("忽略大小写，保留原文的大小写", () => {
    expect(highlight("Fix Login", ["login"])).toEqual([
      { text: "Fix ", match: false },
      { text: "Login", match: true },
    ]);
  });

  it("重叠与相邻的命中合并成一段", () => {
    expect(highlight("abcdef", ["abc", "cde"])).toEqual([
      { text: "abcde", match: true },
      { text: "f", match: false },
    ]);
  });

  it("没有命中与空文字", () => {
    expect(highlight("没有", ["登录"])).toEqual([{ text: "没有", match: false }]);
    expect(highlight("", ["a"])).toEqual([]);
  });

  it("小写后长度会变化的字符不会造成高亮错位", () => {
    expect(highlight("İstanbul", ["stan"])).toEqual([{ text: "İstanbul", match: false }]);
  });
});

describe("snippetAround", () => {
  it("取命中位置附近，折叠换行，两端被截断时带省略号", () => {
    const content = `${"前".repeat(100)}\n关键词在这里\n${"后".repeat(100)}`;
    const snippet = snippetAround(content, ["关键词"]);
    expect(snippet).toContain("关键词在这里");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).not.toContain("\n");
    expect(snippet.length).toBeLessThan(120);
  });

  it("命中在开头时不加前导省略号", () => {
    expect(snippetAround("登录页改版完成", ["登录"])).toBe("登录页改版完成");
  });

  it("正文没有命中时取开头；没有正文返回空串", () => {
    expect(snippetAround("很短的正文", ["标题里的词"])).toBe("很短的正文");
    const long = "字".repeat(200);
    const head = snippetAround(long, ["x"]);
    expect(head.endsWith("…")).toBe(true);
    expect([...head]).toHaveLength(73);
    expect(snippetAround(null, ["x"])).toBe("");
    expect(snippetAround("  \n ", ["x"])).toBe("");
  });
});
