/**
 * 笔记列表的筛选：标题或内容里包含筛选词（不区分大小写；词之间用空格分开时每个词都要出现）。
 *
 * 只在已经加载到前端的笔记里筛，不走搜索索引：笔记列表本来就是全量的，输入时不需要等待。
 *
 * @param note 笔记的标题与内容。
 * @param query 筛选框里的文字。
 * @returns 匹配（或筛选词为空）时为 `true`。
 */
export function noteMatches(
  note: { title: string; content: string | null },
  query: string,
): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${note.title}\n${note.content ?? ""}`.toLocaleLowerCase();
  return words.every((word) => text.includes(word));
}
