import type { ShortcutActionDto } from "./ipc";

/**
 * Query Key 工厂。所有 TanStack Query 的 Key 都必须由这里生成，
 * 禁止在业务代码中手写数组字面量（前端规范 §7.2）。
 */
export const queryKeys = {
  /** 所有 Item 列表查询的前缀，用于一次性失效全部列表。 */
  items: () => ["items"] as const,
  /** 带过滤条件的 Item 列表。 */
  itemList: (filter: { includeArchived: boolean }) => ["items", "list", filter] as const,
  /** Notes 列表（最近更新的在前，未归档）；属于 `items` 前缀，Item 变化时会一起失效。 */
  notes: () => ["items", "notes"] as const,
  /** 项目列表（侧栏，含未完成数量）；项目内的 Item 列表见 `projectItems`。 */
  projects: () => ["projects"] as const,
  /** 某个项目的 Item 列表（项目视图排序）；属于 `items` 前缀，Item 变化时会一起失效。 */
  projectItems: (projectId: string) => ["items", "project", projectId] as const,
  /** 全部标签与数量（标签管理、自动补全）。 */
  tags: () => ["tags"] as const,
  /** 某个标签的 Item 列表；属于 `items` 前缀。 */
  tagItems: (tagId: string) => ["items", "tag", tagId] as const,
  /** 全文搜索的结果；属于 `items` 前缀，Item 变化时会一起失效。 */
  search: (query: string) => ["items", "search", query] as const,
  /** 全部搜索结果的前缀（全局搜索框每次出现时丢弃旧结果）。 */
  searchAll: () => ["items", "search"] as const,
  /** Calendar 的某一页；属于 `items` 前缀，Item 变化时会一起失效。 */
  calendar: (view: string, anchor: string) => ["items", "calendar", view, anchor] as const,
  /** 设置页的设置（开机自启、置顶、「稍后」规则）。 */
  appSettings: () => ["app-settings"] as const,
  /** 回收站里的条目。 */
  trash: () => ["trash"] as const,
  /** Workflow 列表。 */
  workflows: () => ["workflows"] as const,
  integrations: () => ["integrations"] as const,
  /** Workflow 最近的运行记录。 */
  workflowRuns: () => ["workflows", "runs"] as const,
  /** Today 视图（待办 / 提示 / 今日已完成）。 */
  today: () => ["today"] as const,
  /** Inbox 列表（等待整理的 Item，含来源与附件）。 */
  inbox: () => ["inbox"] as const,
  /** Inbox 数量。 */
  inboxCount: () => ["inbox", "count"] as const,
  /** 全局快捷键的绑定与注册状态。 */
  shortcut: (action: ShortcutActionDto) => ["shortcut", action] as const,
  /** 所有单个 Item 查询（含详情）的前缀，用于一次性失效。 */
  itemsOne: () => ["item"] as const,
  /** 单个 Item。 */
  item: (id: string) => ["item", id] as const,
  /** 单个 Item 的详情（含来源与附件）。 */
  itemDetail: (id: string) => ["item", id, "detail"] as const,
};
