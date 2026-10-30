/**
 * 筛选框里的文字拆成筛选词（转小写，按空白分开，去掉空词）。
 *
 * @param query 筛选框里的文字。
 * @returns 筛选词；为空时表示不筛选。
 */
export function filterWords(query: string): string[] {
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 一篇笔记用来筛选的文字：标题与内容，转小写。列表加载后算一次，输入时不再重复转换长文。
 *
 * @param note 笔记的标题与内容。
 * @returns 小写的标题与内容。
 */
export function noteSearchText(note: { title: string; content: string | null }): string {
  return `${note.title}\n${note.content ?? ""}`.toLocaleLowerCase();
}

/**
 * 笔记列表的筛选：标题或内容里包含筛选词（不区分大小写；词之间用空格分开时每个词都要出现）。
 *
 * 只在已经加载到前端的笔记里筛，不走搜索索引：笔记列表本来就是全量的，输入时不需要等待。
 * 页面上用 [`noteSearchText`] 预先算好的文字筛选，这里是一次性的便捷写法。
 *
 * @param note 笔记的标题与内容。
 * @param query 筛选框里的文字。
 * @returns 匹配（或筛选词为空）时为 `true`。
 */
export function noteMatches(
  note: { title: string; content: string | null },
  query: string,
): boolean {
  const words = filterWords(query);
  if (words.length === 0) return true;
  const text = noteSearchText(note);
  return words.every((word) => text.includes(word));
}
