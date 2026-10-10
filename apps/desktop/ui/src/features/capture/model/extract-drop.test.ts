import { describe, expect, it } from "vitest";
import { extractCapture, snapshotDrop, toBase64 } from "./extract-drop";
import type { DropSnapshot } from "./extract-drop";

/** 构造快照，未指定的格式为空。 */
function snap(partial: Partial<DropSnapshot>): DropSnapshot {
  return { uriList: "", mozUrl: "", text: "", files: [], ...partial };
}

describe("extractCapture", () => {
  it("浏览器拖来的链接（uri-list）被捕获为网址文本", async () => {
    const result = await extractCapture(
      snap({ uriList: "# comment\r\nhttps://example.com/a\r\n", text: "https://example.com/a" }),
    );
    expect(result).toEqual({
      kind: "input",
      input: { kind: "text", text: "https://example.com/a" },
    });
  });

  it("Firefox 的 x-moz-url 取第一行网址，不带标题", async () => {
    const result = await extractCapture(snap({ mozUrl: "https://example.com/p\n页面标题" }));
    expect(result).toEqual({
      kind: "input",
      input: { kind: "text", text: "https://example.com/p" },
    });
  });

  it("链接优先于同时携带的文本，非 http 协议不算链接", async () => {
    const linkWins = await extractCapture(snap({ uriList: "https://a.com", text: "点这里查看" }));
    expect(linkWins).toMatchObject({ input: { text: "https://a.com" } });
    const notHttp = await extractCapture(snap({ uriList: "javascript:alert(1)", text: "文字" }));
    expect(notHttp).toEqual({ kind: "input", input: { kind: "text", text: "文字" } });
  });

  it("选中的文本原样交给后端（由后端决定是否是网址）", async () => {
    const result = await extractCapture(snap({ text: "  整理周报\n第二行 " }));
    expect(result).toEqual({
      kind: "input",
      input: { kind: "text", text: "  整理周报\n第二行 " },
    });
  });

  it("图片文件作为图片捕获，字节被 Base64 编码", async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" });
    const result = await extractCapture(
      snap({ files: [file], uriList: "https://img.example/a.png" }),
    );
    expect(result).toEqual({ kind: "input", input: { kind: "image", data_base64: "iVBORw==" } });
  });

  it("非图片文件拿不到路径：明确返回 unsupported，而不是丢弃或伪造", async () => {
    const file = new File(["x"], "报告.pdf", { type: "application/pdf" });
    expect(await extractCapture(snap({ files: [file] }))).toEqual({
      kind: "unsupported",
      reason: "files",
    });
  });

  it("什么都没有 / 只有空白文本时返回 empty", async () => {
    expect(await extractCapture(snap({}))).toEqual({ kind: "unsupported", reason: "empty" });
    expect(await extractCapture(snap({ text: " \n " }))).toEqual({
      kind: "unsupported",
      reason: "empty",
    });
  });
});

describe("snapshotDrop", () => {
  it("读取各格式；getData 抛错时按空处理", () => {
    const snapshot = snapshotDrop({
      getData: (format) => {
        if (format === "text/plain") return "hi";
        throw new Error("denied");
      },
      files: [],
    });
    expect(snapshot).toEqual({ uriList: "", mozUrl: "", text: "hi", files: [] });
  });
});

describe("toBase64", () => {
  it("大数组也能编码，且与逐字节结果一致", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});
