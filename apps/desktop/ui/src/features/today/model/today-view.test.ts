import { describe, expect, it } from "vitest";
import type { TodayItemDto, TodayViewDto } from "@/lib/ipc";
import { applyCompleted, applyReopened, findTodo } from "./today-view";

/** 构造一个待办条目。 */
function todo(id: string, isOverdue = false): TodayItemDto {
  return {
    id,
    itemType: "todo",
    title: id,
    status: "open",
    priority: "none",
    scheduled: { date: "2026-10-10", time: null },
    due: null,
    isOverdue,
  };
}

/** 三条待办的视图。 */
const VIEW: TodayViewDto = {
  date: "2026-10-10",
  remainingCount: 3,
  todos: [todo("a"), todo("b", true), todo("c")],
  tips: [],
  completed: [],
};

describe("today-view", () => {
  it("完成：移出待办、追加到已完成、计数减一，并清除逾期标记", () => {
    const next = applyCompleted(VIEW, "b");
    expect(next.todos.map((t) => t.id)).toEqual(["a", "c"]);
    expect(next.completed.map((t) => [t.id, t.status, t.isOverdue])).toEqual([
      ["b", "done", false],
    ]);
    expect(next.remainingCount).toBe(2);
  });

  it("完成一个不存在的条目不改变视图", () => {
    expect(applyCompleted(VIEW, "zzz")).toBe(VIEW);
  });

  it("撤销：放回原来的位置并恢复计数与逾期标记", () => {
    const position = findTodo(VIEW, "b");
    expect(position?.index).toBe(1);
    if (position === null) throw new Error("not found");
    const done = applyCompleted(VIEW, "b");
    const back = applyReopened(done, position.item, position.index);
    expect(back).toEqual(VIEW);
  });

  it("撤销时下标越界则放到末尾", () => {
    const done = applyCompleted(VIEW, "a");
    const back = applyReopened(done, todo("a"), 99);
    expect(back.todos.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});
