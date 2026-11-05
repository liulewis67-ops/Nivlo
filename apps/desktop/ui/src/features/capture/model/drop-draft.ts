import type { ItemLinkDto, ItemTypeDto } from "@/lib/ipc";
import type { DropSnapshot } from "./extract-drop";
import { requestFilePaths } from "./native-paths";

/** 与后端 `MAX_ITEM_LINKS` 一致：一个事项最多带多少条关联资料。 */
export const MAX_DRAFT_LINKS = 20;

/** 草稿里的一条关联资料：网页，或本地文件 / 文件夹的引用（只记位置，不复制）。 */
export type DraftLink =
  { kind: "web"; url: string; title: string | null } | { kind: "file"; path: string; name: string };

/** 拖入内容预填出的新增草稿。 */
export type DropDraft = {
  /** 建议的类型：链接与文件是笔记，文字是待办。 */
  kind: ItemTypeDto;
  /** 建议的标题；`null` 时由界面按关联资料生成（需要翻译「等 N 项」）。 */
  title: string | null;
  /** 预填的内容（多行文字的全文）；没有时为空字符串。 */
  content: string;
  /** 关联资料，已去重。 */
  links: DraftLink[];
};

/**
 * 拖放用于新建事项时的提取结果：
 * 预填草稿；只能走收集箱（没有路径也没有网址的图片，只能复制保存）；或者无法处理。
 */
export type DraftExtraction =
  | { kind: "draft"; draft: DropDraft }
  | { kind: "inbox" }
  | { kind: "unsupported"; reason: "files" | "empty" };

/** 与后端 `MAX_TITLE_CHARS` 一致。 */
const MAX_TITLE_CHARS = 500;

/** 判断一行是否是 `http(s)` 网址。 */
function isHttpUrl(line: string): boolean {
  return /^https?:\/\/\S+$/i.test(line);
}

/** 折叠空白并去掉首尾空白；空字符串视为没有。 */
function clean(text: string | null | undefined): string | null {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value === "" ? null : value.slice(0, MAX_TITLE_CHARS);
}

/**
 * 从 `text/html` 里取出链接文字（`<a href>文字</a>`）与图片说明（`<img alt>`），按网址索引。
 * 只用 `DOMParser` 解析成惰性文档读取文本，不执行脚本、不插入页面。
 */
function htmlTitles(html: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (html.trim() === "" || typeof DOMParser === "undefined") return titles;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
    const title = clean(anchor.textContent);
    const href = anchor.getAttribute("href") ?? "";
    if (title !== null && !titles.has(href)) titles.set(href, title);
  }
  for (const image of Array.from(doc.querySelectorAll("img[src]"))) {
    const title = clean(image.getAttribute("alt"));
    const src = image.getAttribute("src") ?? "";
    if (title !== null && !titles.has(src)) titles.set(src, title);
  }
  return titles;
}

/**
 * 取出全部网页链接：`text/uri-list`（`#` 开头为注释）、Firefox 的 `text/x-moz-url`（网址与标题交替成行）。
 * 标题依次来自 moz-url、HTML 链接文字；只有一个链接时，与网址不同的纯文本也可以当标题。
 */
function webLinks(snapshot: DropSnapshot): DraftLink[] {
  const titles = htmlTitles(snapshot.html);
  const mozLines = snapshot.mozUrl.split(/\r?\n/).map((line) => line.trim());
  for (let index = 0; index + 1 < mozLines.length; index += 2) {
    const url = mozLines[index] ?? "";
    const title = clean(mozLines[index + 1]);
    if (isHttpUrl(url) && title !== null) titles.set(url, title);
  }
  const urls = [
    ...snapshot.uriList.split(/\r?\n/),
    ...mozLines.filter((_, index) => index % 2 === 0),
  ]
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && isHttpUrl(line));
  const unique = [...new Set(urls)];
  const text = clean(snapshot.text);
  return unique.map((url) => ({
    kind: "web" as const,
    url,
    title:
      titles.get(url) ??
      (unique.length === 1 && text !== null && text !== url && !isHttpUrl(text) ? text : null),
  }));
}

/** 路径的最后一段（文件名或文件夹名）。 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

/**
 * 关联资料的去重键：网页按网址，文件按路径（Windows 路径不区分大小写、分隔符可混用）。
 *
 * @param link 关联资料。
 * @returns 去重键。
 */
export function linkKey(link: DraftLink): string {
  return link.kind === "web"
    ? `web:${link.url}`
    : `file:${link.path.replace(/\\/g, "/").toLowerCase()}`;
}

/**
 * 把新的关联资料合并进已有的：保持顺序、去重，不超过上限。
 *
 * @param current 已有的关联资料。
 * @param incoming 新拖入的关联资料。
 * @returns 合并后的关联资料。
 */
export function mergeLinks(
  current: readonly DraftLink[],
  incoming: readonly DraftLink[],
): DraftLink[] {
  const seen = new Set(current.map(linkKey));
  const merged = [...current];
  for (const link of incoming) {
    const key = linkKey(link);
    if (seen.has(key) || merged.length >= MAX_DRAFT_LINKS) continue;
    seen.add(key);
    merged.push(link);
  }
  return merged;
}

/**
 * 草稿关联资料 → IPC 请求里的 `links`：文件只传路径，元数据由后端读取。
 *
 * @param links 草稿里的关联资料。
 * @returns 请求用的关联资料。
 */
export function toLinkDtos(links: readonly DraftLink[]): ItemLinkDto[] {
  return links.map((link) =>
    link.kind === "web"
      ? { kind: "web", url: link.url, title: link.title }
      : { kind: "file", path: link.path },
  );
}

/**
 * 网址的简短显示：主机 + 路径（去掉 `www.` 与末尾的 `/`）。
 *
 * @param url 网址。
 * @returns 显示文字；解析失败时原样返回。
 */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

/** 多行或超长文字：标题取首行，全文放进内容（与收集箱的默认规则一致）。 */
function textDraft(text: string): DropDraft {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  const title = [...firstLine].slice(0, MAX_TITLE_CHARS).join("");
  return { kind: "todo", title, content: title === trimmed ? "" : trimmed, links: [] };
}

/**
 * 把拖放快照变成新增配置页的草稿（场景见 `docs/development/floating-drop-create.md`）。
 *
 * 优先级：文件（向宿主索取路径，作为引用）→ 网页链接 → 文字。
 * 浏览器里拖出的图片同时带着图片字节与网址：直接用网址，不必向宿主要路径（它没有路径）；
 * 只有字节的图片无法引用，交回收集箱捕获（复制保存）。
 *
 * @param snapshot 拖放快照。
 * @param resolvePaths 取文件磁盘路径的函数（测试注入）。
 * @returns 提取结果。
 */
export async function extractDraft(
  snapshot: DropSnapshot,
  resolvePaths: (files: readonly File[]) => Promise<string[] | null> = requestFilePaths,
): Promise<DraftExtraction> {
  const web = webLinks(snapshot);
  const onlyImages =
    snapshot.files.length > 0 && snapshot.files.every((file) => file.type.startsWith("image/"));
  if (snapshot.files.length > 0 && !(onlyImages && web.length > 0)) {
    const paths = await resolvePaths(snapshot.files);
    if (paths !== null) {
      const links = mergeLinks(
        [],
        paths.map((path) => ({ kind: "file" as const, path, name: baseName(path) })),
      );
      return { kind: "draft", draft: { kind: "note", title: null, content: "", links } };
    }
    if (onlyImages) return { kind: "inbox" };
    return { kind: "unsupported", reason: "files" };
  }
  if (web.length > 0) {
    return {
      kind: "draft",
      draft: { kind: "note", title: null, content: "", links: mergeLinks([], web) },
    };
  }
  if (snapshot.text.trim().length > 0) return { kind: "draft", draft: textDraft(snapshot.text) };
  return { kind: "unsupported", reason: "empty" };
}
