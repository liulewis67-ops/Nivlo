/**
 * 筛选框里的文字拆成筛选词（转小写，按空白分开，去掉空词）。笔记与收集箱的筛选共用。
 *
 * @param query 筛选框里的文字。
 * @returns 筛选词；为空时表示不筛选。
 */
export function filterWords(query: string): string[] {
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 小写的待查文字里是否包含全部筛选词。
 *
 * @param text 已经转成小写的待查文字。
 * @param words [`filterWords`] 拆出的筛选词。
 * @returns 全部包含（或没有筛选词）时为 `true`。
 */
export function matchesAllWords(text: string, words: readonly string[]): boolean {
  return words.every((word) => text.includes(word));
}
