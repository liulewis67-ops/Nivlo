import { describe, expect, it } from "vitest";
import type { InboxEntryDto, ItemDto } from "@/lib/ipc";
import { baseName, pruneSelection, selectRange, shortenUrl, summarizeEntry } from "./inbox-entry";

/** 构造一条 Inbox 条目，只覆盖测试关心的部分。 */
function entry(partial: Partial<InboxEntryDto>): InboxEntryDto {
  const item: ItemDto = {
    id: "1",
    itemType: "note",
    title: "t",
    brief: null,
    content: null,
    contentFormat: "plain",
    status: "open",
    priority: "none",
    scheduled: null,
    due: null,
    reminderAt: null,
    projectId: null,
    inInbox: true,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
  };
  return { item, sources: [], attachments: [], tags: [], ...partial };
}

/** 构造来源。 */
function source(sourceType: string, extra: Record<string, string | null> = {}) {
  return {
    sourceType,
    sourceApp: null,
    sourceUrl: null,
    sourcePath: null,
    originalTitle: null,
    capturedAt: "2026-10-10T00:00:00.000Z",
    ...extra,
  };
}

describe("shortenUrl", () => {
  it("去掉协议、www、末尾斜杠、查询与 fragment", () => {
    expect(shortenUrl("https://www.example.com/docs/a/?x=1#top")).toBe("example.com/docs/a");
    expect(shortenUrl("http://example.com/")).toBe("example.com");
  });

  it("解析失败时原样返回", () => {
    expect(shortenUrl("not a url")).toBe("not a url");
  });
});

describe("baseName", () => {
  it("同时处理 Windows 与 POSIX 路径、中文与空格、末尾分隔符", () => {
    expect(baseName("C:\\Users\\张三\\我的 文档\\报告 final.pdf")).toBe("报告 final.pdf");
    expect(baseName("/home/a/b.txt")).toBe("b.txt");
    expect(baseName("D:\\folder\\")).toBe("folder");
    expect(baseName("")).toBe("");
  });
});

describe("summarizeEntry", () => {
  it("网址：类别为 url，说明是主机 + 路径", () => {
    const summary = summarizeEntry(
      entry({
        sources: [source("web", { sourceUrl: "https://www.a.com/x/", sourceApp: "Chrome" })],
      }),
    );
    expect(summary).toEqual({ kind: "url", detail: "a.com/x", app: "Chrome", missingFile: false });
  });

  it("文件：说明是文件名；文件还在时不是缺失", () => {
    const summary = summarizeEntry(
      entry({
        sources: [source("file", { sourcePath: "C:\\a\\b.pdf" })],
        attachments: [
          {
            kind: "reference",
            path: "C:\\a\\b.pdf",
            name: "b.pdf",
            mime: null,
            sizeBytes: 1,
            exists: true,
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ kind: "file", detail: "b.pdf", missingFile: false });
  });

  it("被引用的文件已被移走：标记缺失，仍然正常返回", () => {
    const summary = summarizeEntry(
      entry({
        sources: [source("file", { sourcePath: "C:\\a\\b.pdf" })],
        attachments: [
          {
            kind: "reference",
            path: "C:\\a\\b.pdf",
            name: "b.pdf",
            mime: null,
            sizeBytes: 1,
            exists: false,
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ kind: "file", detail: "b.pdf", missingFile: true });
  });

  it("保存在 AsterJot 里的图片不会被当成缺失文件", () => {
    const summary = summarizeEntry(
      entry({
        sources: [source("image")],
        attachments: [
          {
            kind: "stored",
            path: "x.png",
            name: "图片",
            mime: "image/png",
            sizeBytes: 1,
            exists: true,
          },
        ],
      }),
    );
    expect(summary).toMatchObject({ kind: "image", missingFile: false });
  });

  it("文本与没有来源的条目", () => {
    expect(summarizeEntry(entry({ sources: [source("text")] })).kind).toBe("text");
    expect(summarizeEntry(entry({})).kind).toBe("other");
  });
});

describe("selectRange", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("正向与反向都包含两端", () => {
    expect(selectRange(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(selectRange(order, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("锚点不在列表里（已被整理走）时只选中目标", () => {
    expect(selectRange(order, "zzz", "c")).toEqual(["c"]);
  });
});

describe("pruneSelection", () => {
  it("丢弃不在列表里的选中项", () => {
    expect([...pruneSelection(new Set(["a", "x"]), ["a", "b"])]).toEqual(["a"]);
  });

  it("没有变化时返回同一个集合", () => {
    const selected = new Set(["a"]);
    expect(pruneSelection(selected, ["a", "b"])).toBe(selected);
  });
});
