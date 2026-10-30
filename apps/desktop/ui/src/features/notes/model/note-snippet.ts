/** 列表里摘要的最大字符数。 */
export const SNIPPET_MAX_CHARS = 80;

/**
 * 笔记列表里的内容摘要：去掉常见的 Markdown 标记，取第一段有内容的文字，按字符截断。
 *
 * 只用于列表展示，不改动笔记本身；按字符（而不是字节）截断，中文不会被切坏。
 *
 * @param content 笔记内容；没有内容为 `null`。
 * @returns 摘要；没有内容时为空串。
 */
export function noteSnippet(content: string | null): string {
  if (content === null) return "";
  // 逐行往下找，找到第一段有内容的就停：列表每次渲染都会算摘要，长文不必整篇拆行再清理。
  let firstLine = "";
  let from = 0;
  while (from <= content.length) {
    const end = content.indexOf("\n", from);
    const line = content
      .slice(from, end === -1 ? content.length : end)
      .replace(/^[#>*\-+\s]+/, "")
      .trim();
    if (line.length > 0) {
      firstLine = line;
      break;
    }
    if (end === -1) break;
    from = end + 1;
  }
  const chars = [...firstLine];
  return chars.length <= SNIPPET_MAX_CHARS
    ? firstLine
    : `${chars
        .slice(0, SNIPPET_MAX_CHARS - 1)
        .join("")
        .trimEnd()}…`;
}
