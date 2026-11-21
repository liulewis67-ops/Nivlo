/** 一段文字：是否是搜索词命中的部分。 */
export type Segment = {
  /** 文字。 */
  text: string;
  /** 是否命中搜索词。 */
  match: boolean;
};

/** 摘要在命中位置前后各保留多少个字符。 */
const SNIPPET_RADIUS = 28;

/** 没有命中正文时，摘要取开头的多少个字符。 */
const SNIPPET_HEAD = 72;

/**
 * 把查询拆成搜索词（按空白拆分，统一小写，去重）。
 *
 * @param query 用户输入的查询。
 * @returns 搜索词；空白查询得到空数组。
 */
export function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term !== ""),
    ),
  ];
}

/**
 * 找出文字里所有命中搜索词的区间并合并重叠部分（忽略大小写）。
 *
 * 逐字符比较时用 `toLowerCase` 的结果，因此只在两者长度一致时才可靠；个别字符（如 `İ`）小写后
 * 长度会变，此时放弃高亮而不是高亮错位。
 *
 * @param text 原文。
 * @param terms 搜索词（已小写）。
 * @returns 按位置排序、互不重叠的 `[start, end)` 区间。
 */
function matchRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return [];
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      ranges.push([at, at + term.length]);
      from = at + term.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/**
 * 把文字切成「命中 / 未命中」的片段，用于高亮搜索词。
 *
 * @param text 原文。
 * @param terms 搜索词（已小写，见 [`searchTerms`]）。
 * @returns 依次拼起来等于原文的片段；没有命中时只有一个未命中片段（空文字返回空数组）。
 */
export function highlight(text: string, terms: readonly string[]): Segment[] {
  if (text === "") return [];
  const segments: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of matchRanges(text, terms)) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

/**
 * 取正文里命中位置附近的一小段作为摘要（把换行与连续空白折叠成一个空格）。
 *
 * 正文没有命中（命中在标题或来源里）时取开头一段；没有正文返回空串。
 *
 * @param content 正文；`null` 表示没有。
 * @param terms 搜索词（已小写）。
 * @returns 摘要，前后被截断的地方带「…」。
 */
export function snippetAround(content: string | null, terms: readonly string[]): string {
  if (content === null) return "";
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  const first = matchRanges(flat, terms)[0];
  if (first === undefined) {
    const head = [...flat];
    return head.length <= SNIPPET_HEAD ? flat : `${head.slice(0, SNIPPET_HEAD).join("")}…`;
  }
  const start = Math.max(0, first[0] - SNIPPET_RADIUS);
  const end = Math.min(flat.length, first[1] + SNIPPET_RADIUS * 2);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
