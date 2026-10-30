import type { TodayItemDto, TodayViewDto } from "@/lib/ipc";

/** 一条待办在完成前的位置，撤销时据此原样放回。 */
export type TodoPosition = {
  /** 完成前的条目。 */
  item: TodayItemDto;
  /** 完成前在待办列表中的下标。 */
  index: number;
};

/**
 * 在视图中找到一条待办及其下标。
 *
 * @param view Today 视图。
 * @param id Item ID。
 * @returns 位置；不在待办列表中时为 `null`。
 */
export function findTodo(view: TodayViewDto, id: string): TodoPosition | null {
  const index = view.todos.findIndex((todo) => todo.id === id);
  const item = view.todos[index];
  return item === undefined ? null : { item, index };
}

/**
 * 一个条目所在的未完成列表：提示在 `tips`，其余（待办）在 `todos`。
 *
 * @param item Today 条目。
 * @returns 列表的键。
 */
function openListOf(item: Pick<TodayItemDto, "itemType">): "todos" | "tips" {
  return item.itemType === "tip" ? "tips" : "todos";
}

/**
 * 在未完成的待办或提示里找到一个条目及其下标（完成前记下，撤销时放回原位）。
 *
 * @param view Today 视图。
 * @param id Item ID。
 * @returns 位置；两个列表里都没有时为 `null`。
 */
export function findOpen(view: TodayViewDto, id: string): TodoPosition | null {
  for (const list of [view.todos, view.tips]) {
    const index = list.findIndex((entry) => entry.id === id);
    const item = list[index];
    if (item !== undefined) return { item, index };
  }
  return null;
}

/**
 * 乐观地把一条待办或提示标记为已完成：移出它所在的未完成列表、追加到今日已完成、未完成计数减一。
 *
 * 只用于让界面立即响应；真正的结果以后端事件触发的重新查询为准。
 *
 * @param view 当前视图。
 * @param id 被完成的 Item ID。
 * @returns 新视图；该条目不在未完成的待办 / 提示中时原样返回。
 */
export function applyCompleted(view: TodayViewDto, id: string): TodayViewDto {
  const position = findOpen(view, id);
  if (position === null) return view;
  const list = openListOf(position.item);
  return {
    ...view,
    remainingCount: Math.max(0, view.remainingCount - 1),
    [list]: view[list].filter((entry) => entry.id !== id),
    completed: [...view.completed, { ...position.item, status: "done", isOverdue: false }],
  };
}

/**
 * 乐观地重新打开一条已完成的待办或提示：放回它所属列表的 `index` 处（越界时放到末尾）。
 *
 * @param view 当前视图。
 * @param item 要放回的条目（取完成前的快照，保留逾期标记）。
 * @param index 放回的位置。
 * @returns 新视图。
 */
export function applyReopened(view: TodayViewDto, item: TodayItemDto, index: number): TodayViewDto {
  const key = openListOf(item);
  const existed = view[key].some((entry) => entry.id === item.id);
  const list = view[key].filter((entry) => entry.id !== item.id);
  list.splice(Math.min(index, list.length), 0, { ...item, status: "open" });
  return {
    ...view,
    remainingCount: view.remainingCount + (existed ? 0 : 1),
    [key]: list,
    completed: view.completed.filter((done) => done.id !== item.id),
  };
}

/**
 * 乐观地把待办 `activeId` 移到 `overId` 所在的位置（拖拽排序结束时调用）。
 *
 * @param view 当前视图。
 * @param activeId 被拖动的 Item ID。
 * @param overId 放下位置的 Item ID。
 * @returns 新视图；任一 ID 不在待办中或位置没变时原样返回。
 */
export function applyMove(view: TodayViewDto, activeId: string, overId: string): TodayViewDto {
  const from = view.todos.findIndex((todo) => todo.id === activeId);
  const to = view.todos.findIndex((todo) => todo.id === overId);
  const moved = view.todos[from];
  if (moved === undefined || from === to || to < 0) return view;
  const todos = view.todos.filter((todo) => todo.id !== activeId);
  todos.splice(to, 0, moved);
  return { ...view, todos };
}

/**
 * 乐观地把一条待办从 Today 移走（推迟到明天 / 下周 / 收集箱）：移出待办、计数减一。
 *
 * @param view 当前视图。
 * @param id 被推迟的 Item ID。
 * @returns 新视图；该条目不在待办列表中时原样返回。
 */
export function applyPostponed(view: TodayViewDto, id: string): TodayViewDto {
  if (findTodo(view, id) === null) return view;
  return {
    ...view,
    remainingCount: Math.max(0, view.remainingCount - 1),
    todos: view.todos.filter((todo) => todo.id !== id),
  };
}
