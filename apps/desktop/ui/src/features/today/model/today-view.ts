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
 * 乐观地把一条待办标记为已完成：移出待办、追加到今日已完成、未完成计数减一。
 *
 * 只用于让界面立即响应；真正的结果以后端事件触发的重新查询为准。
 *
 * @param view 当前视图。
 * @param id 被完成的 Item ID。
 * @returns 新视图；该条目不在待办列表中时原样返回。
 */
export function applyCompleted(view: TodayViewDto, id: string): TodayViewDto {
  const position = findTodo(view, id);
  if (position === null) return view;
  return {
    ...view,
    remainingCount: Math.max(0, view.remainingCount - 1),
    todos: view.todos.filter((todo) => todo.id !== id),
    completed: [...view.completed, { ...position.item, status: "done", isOverdue: false }],
  };
}

/**
 * 乐观地重新打开一条已完成的待办：放回待办列表的 `index` 处（越界时放到末尾）。
 *
 * @param view 当前视图。
 * @param item 要放回的条目（取完成前的快照，保留逾期标记）。
 * @param index 放回的位置。
 * @returns 新视图。
 */
export function applyReopened(view: TodayViewDto, item: TodayItemDto, index: number): TodayViewDto {
  const existed = view.todos.some((todo) => todo.id === item.id);
  const todos = view.todos.filter((todo) => todo.id !== item.id);
  todos.splice(Math.min(index, todos.length), 0, { ...item, status: "open" });
  return {
    ...view,
    remainingCount: view.remainingCount + (existed ? 0 : 1),
    todos,
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
