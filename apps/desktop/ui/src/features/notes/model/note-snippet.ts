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
  const firstLine =
    content
      .split("\n")
      .map((line) => line.replace(/^[#>*\-+\s]+/, "").trim())
      .find((line) => line.length > 0) ?? "";
  const chars = [...firstLine];
  return chars.length <= SNIPPET_MAX_CHARS
    ? firstLine
    : `${chars
        .slice(0, SNIPPET_MAX_CHARS - 1)
        .join("")
        .trimEnd()}…`;
}
