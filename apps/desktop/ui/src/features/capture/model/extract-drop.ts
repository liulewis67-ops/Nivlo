import type { CaptureInputDto } from "@/lib/ipc";

/** 一次拖放的原始材料快照；必须在 `drop` 事件回调里同步取得（事件结束后 DataTransfer 就失效）。 */
export type DropSnapshot = {
  /** `text/uri-list` 的内容。 */
  uriList: string;
  /** Firefox 的 `text/x-moz-url`（第一行是网址，第二行是标题）。 */
  mozUrl: string;
  /** `text/plain` 的内容。 */
  text: string;
  /** 拖来的文件（资源管理器的文件、浏览器里的图片）。 */
  files: File[];
};

/** 提取结果：可以捕获的输入，或者无法处理的原因。 */
export type DropExtraction =
  { kind: "input"; input: CaptureInputDto } | { kind: "unsupported"; reason: "files" | "empty" };

/** 只读取 DataTransfer 中需要的部分，便于测试时构造。 */
export type DataTransferLike = {
  getData(format: string): string;
  files: ArrayLike<File>;
};

/**
 * 同步读取 DataTransfer 的快照。
 *
 * @param data 拖放事件的 `dataTransfer`。
 * @returns 快照；缺失的格式为空字符串。
 */
export function snapshotDrop(data: DataTransferLike): DropSnapshot {
  /** 读取一种格式；浏览器拒绝读取时按空字符串处理。 */
  const read = (format: string): string => {
    try {
      return data.getData(format);
    } catch {
      return "";
    }
  };
  return {
    uriList: read("text/uri-list"),
    mozUrl: read("text/x-moz-url"),
    text: read("text/plain"),
    files: Array.from(data.files),
  };
}

/** 判断一行是否是 `http(s)` 网址。 */
function isHttpUrl(line: string): boolean {
  return /^https?:\/\/\S+$/i.test(line);
}

/**
 * 从 `text/uri-list`（`#` 开头为注释）或 Firefox 的 `text/x-moz-url` 里取第一个 http(s) 网址。
 *
 * @param snapshot 拖放快照。
 * @returns 网址；没有时为 `null`。
 */
function firstUrl(snapshot: DropSnapshot): string | null {
  const lines = [...snapshot.uriList.split(/\r?\n/), snapshot.mozUrl.split(/\r?\n/)[0] ?? ""]
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return lines.find(isHttpUrl) ?? null;
}

/**
 * 把字节编码为 Base64（分块，避免大图撑爆 `String.fromCharCode` 的参数上限）。
 *
 * @param bytes 原始字节。
 * @returns 标准字母表的 Base64。
 */
export function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * 把拖放快照变成可捕获的输入。
 *
 * 优先级：图片文件（作为图片附件）→ 链接 → 普通文本。
 * 非图片文件在 WebView2 的 HTML5 drop 里**拿不到磁盘路径**，无法作为文件引用——返回
 * `unsupported`，由调用方明确告诉用户（该项记录在 `docs/development/drop-matrix.md`，
 * 由实施计划 10.1 的原生 Drop 解决），而不是悄悄丢掉或伪造一个路径。
 *
 * @param snapshot 拖放快照。
 * @returns 提取结果。
 */
export async function extractCapture(snapshot: DropSnapshot): Promise<DropExtraction> {
  const image = snapshot.files.find((file) => file.type.startsWith("image/"));
  if (image !== undefined) {
    const bytes = new Uint8Array(await image.arrayBuffer());
    return { kind: "input", input: { kind: "image", data_base64: toBase64(bytes) } };
  }
  const url = firstUrl(snapshot);
  if (url !== null) return { kind: "input", input: { kind: "text", text: url } };
  if (snapshot.files.length > 0) return { kind: "unsupported", reason: "files" };
  if (snapshot.text.trim().length > 0) {
    return { kind: "input", input: { kind: "text", text: snapshot.text } };
  }
  return { kind: "unsupported", reason: "empty" };
}
