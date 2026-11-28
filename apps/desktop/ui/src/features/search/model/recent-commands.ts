/** 最近用过的命令在 localStorage 中的 key（主窗口 Ctrl+K 与全局搜索框共用）。 */
export const RECENT_COMMANDS_KEY = "asterjot.palette.recentCommands";

/** 最多记住几条。 */
export const RECENT_COMMANDS_LIMIT = 5;

/**
 * 读取最近用过的命令 ID（最近的在前）；没有或读不了时为空。
 *
 * @returns 命令 ID。
 */
export function readRecentCommands(): string[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(RECENT_COMMANDS_KEY) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string").slice(0, RECENT_COMMANDS_LIMIT)
      : [];
  } catch {
    // localStorage 不可用或内容损坏：当作没有记录。
    return [];
  }
}

/**
 * 记下刚用过的一条命令：挪到最前面，只保留最近的几条。写不进去时不影响执行。
 *
 * @param id 命令 ID。
 */
export function rememberCommand(id: string): void {
  const next = [id, ...readRecentCommands().filter((other) => other !== id)].slice(
    0,
    RECENT_COMMANDS_LIMIT,
  );
  try {
    window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    // 存不下（隐私模式等）就算了，只是排序提示。
  }
}

/**
 * 把最近用过的命令排到前面（按最近的先后），其余保持原来的顺序。
 *
 * @param items 命令（已经按输入筛过）。
 * @param recent 最近用过的命令 ID，最近的在前。
 * @returns 重新排序后的命令。
 */
export function rankByRecent<T extends { id: string }>(
  items: readonly T[],
  recent: readonly string[],
): T[] {
  /**
   * 一条命令的名次：最近用过的按先后，没用过的都排在它们之后。
   *
   * @param item 命令。
   * @returns 名次，越小越靠前。
   */
  const rank = (item: T): number => {
    const index = recent.indexOf(item.id);
    return index === -1 ? recent.length : index;
  };
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.order - b.order)
    .map(({ item }) => item);
}
