/**
 * Query Key 工厂。所有 TanStack Query 的 Key 都必须由这里生成，
 * 禁止在业务代码中手写数组字面量（前端规范 §7.2）。
 */
export const queryKeys = {
  /** 所有 Item 列表查询的前缀，用于一次性失效全部列表。 */
  items: () => ["items"] as const,
  /** 带过滤条件的 Item 列表。 */
  itemList: (filter: { includeArchived: boolean }) => ["items", "list", filter] as const,
  /** Today 视图（待办 / 提示 / 今日已完成）。 */
  today: () => ["today"] as const,
  /** Inbox 列表（等待整理的 Item，含来源与附件）。 */
  inbox: () => ["inbox"] as const,
  /** Inbox 数量。 */
  inboxCount: () => ["inbox", "count"] as const,
  /** 全局快捷键的绑定与注册状态。 */
  shortcut: () => ["shortcut"] as const,
  /** 单个 Item 详情。 */
  item: (id: string) => ["item", id] as const,
};
