import { describe, expect, it } from "vitest";
import {
  MAX_DRAFT_LINKS,
  baseName,
  extractDraft,
  mergeLinks,
  shortUrl,
  toLinkDtos,
} from "./drop-draft";
import type { DraftLink } from "./drop-draft";
import type { DropSnapshot } from "./extract-drop";

/** 构造快照，未指定的格式为空。 */
function snap(partial: Partial<DropSnapshot>): DropSnapshot {
  return { uriList: "", mozUrl: "", text: "", html: "", files: [], ...partial };
}

/** 宿主不给路径（不在 WebView2 里）。 */
const noPaths = async (): Promise<string[] | null> => null;

/** 宿主按文件名给出路径。 */
const pathsIn =
  (folder: string) =>
  async (files: readonly File[]): Promise<string[] | null> =>
    files.map((file) => `${folder}\\${file.name}`);

describe("extractDraft：拖放新建事项的场景", () => {
  it("Chrome / Edge 地址栏：网址 + HTML 链接文字作为页面标题，预填为笔记", async () => {
    const result = await extractDraft(
      snap({
        uriList: "https://example.com/docs/guide",
        text: "https://example.com/docs/guide",
        html: '<a href="https://example.com/docs/guide">使用指南 - Example</a>',
      }),
      noPaths,
    );
    expect(result).toEqual({
      kind: "draft",
      draft: {
        kind: "note",
        title: null,
        content: "",
        links: [
          { kind: "web", url: "https://example.com/docs/guide", title: "使用指南 - Example" },
        ],
      },
    });
  });

  it("Firefox 标签页：x-moz-url 的第二行是标题", async () => {
    const result = await extractDraft(snap({ mozUrl: "https://a.com/p\nA 页面" }), noPaths);
    expect(result).toMatchObject({
      draft: { links: [{ kind: "web", url: "https://a.com/p", title: "A 页面" }] },
    });
  });

  it("一个链接 + 与网址不同的文字：文字当标题；多个链接去重且不借用文字", async () => {
    const one = await extractDraft(snap({ uriList: "https://a.com", text: "点这里" }), noPaths);
    expect(one).toMatchObject({ draft: { links: [{ title: "点这里" }] } });

    const many = await extractDraft(
      snap({
        uriList: "# 注释\r\nhttps://a.com\r\nhttps://b.com\r\nhttps://a.com",
        text: "文字",
      }),
      noPaths,
    );
    expect(many).toMatchObject({
      draft: {
        links: [
          { url: "https://a.com", title: null },
          { url: "https://b.com", title: null },
        ],
      },
    });
  });

  it("非 http(s) 网址不会成为网页关联，退回为文字", async () => {
    const result = await extractDraft(
      snap({ uriList: "javascript:alert(1)\r\nfile:///C:/x.txt", text: "文字" }),
      noPaths,
    );
    expect(result).toMatchObject({ draft: { kind: "todo", title: "文字", links: [] } });
  });

  it("选中的多行文字：待办，标题取首行，全文放进内容", async () => {
    const result = await extractDraft(snap({ text: "  整理周报\n第二行 " }), noPaths);
    expect(result).toEqual({
      kind: "draft",
      draft: { kind: "todo", title: "整理周报", content: "整理周报\n第二行", links: [] },
    });
    const single = await extractDraft(snap({ text: "买牛奶" }), noPaths);
    expect(single).toMatchObject({ draft: { title: "买牛奶", content: "" } });
  });

  it("资源管理器里的文件（含图片）：只作为路径引用，不读取字节", async () => {
    const pdf = new File(["x"], "报告.pdf", { type: "application/pdf" });
    const png = new File([new Uint8Array([1])], "截图.png", { type: "image/png" });
    const result = await extractDraft(snap({ files: [pdf, png] }), pathsIn("D:\\资料"));
    expect(result).toEqual({
      kind: "draft",
      draft: {
        kind: "note",
        title: null,
        content: "",
        links: [
          { kind: "file", path: "D:\\资料\\报告.pdf", name: "报告.pdf" },
          { kind: "file", path: "D:\\资料\\截图.png", name: "截图.png" },
        ],
      },
    });
  });

  it("网页里的图片：用图片网址与 alt 文字，不向宿主要路径", async () => {
    let asked = false;
    const spy = async (): Promise<string[] | null> => {
      asked = true;
      return null;
    };
    const image = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const result = await extractDraft(
      snap({
        files: [image],
        uriList: "https://img.example/a.png",
        html: '<img src="https://img.example/a.png" alt="架构图">',
      }),
      spy,
    );
    expect(asked).toBe(false);
    expect(result).toMatchObject({
      draft: { links: [{ kind: "web", url: "https://img.example/a.png", title: "架构图" }] },
    });
  });

  it("没有路径也没有网址的图片只能复制保存：交回收集箱", async () => {
    const image = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    expect(await extractDraft(snap({ files: [image] }), noPaths)).toEqual({ kind: "inbox" });
  });

  it("拿不到路径的普通文件、什么都没有：明确不支持", async () => {
    const file = new File(["x"], "a.zip");
    expect(await extractDraft(snap({ files: [file] }), noPaths)).toEqual({
      kind: "unsupported",
      reason: "files",
    });
    expect(await extractDraft(snap({ text: " \n " }), noPaths)).toEqual({
      kind: "unsupported",
      reason: "empty",
    });
  });
});

describe("关联资料工具", () => {
  it("合并时按网址 / 路径去重（路径不区分大小写与分隔符），且不超过上限", () => {
    const current: DraftLink[] = [{ kind: "file", path: "D:\\A\\b.pdf", name: "b.pdf" }];
    const merged = mergeLinks(current, [
      { kind: "file", path: "d:/a/B.pdf", name: "B.pdf" },
      { kind: "web", url: "https://a.com", title: null },
    ]);
    expect(merged).toHaveLength(2);

    const many = Array.from({ length: MAX_DRAFT_LINKS + 5 }, (_, i) => ({
      kind: "web" as const,
      url: `https://a.com/${i}`,
      title: null,
    }));
    expect(mergeLinks([], many)).toHaveLength(MAX_DRAFT_LINKS);
  });

  it("请求里文件只传路径", () => {
    expect(
      toLinkDtos([
        { kind: "web", url: "https://a.com", title: "A" },
        { kind: "file", path: "D:\\x.pdf", name: "x.pdf" },
      ]),
    ).toEqual([
      { kind: "web", url: "https://a.com", title: "A" },
      { kind: "file", path: "D:\\x.pdf" },
    ]);
  });

  it("显示用的文件名与简短网址", () => {
    expect(baseName("D:\\资料\\项目\\")).toBe("项目");
    expect(baseName("/home/a/b.txt")).toBe("b.txt");
    expect(shortUrl("https://www.example.com/docs/")).toBe("example.com/docs");
  });
});
