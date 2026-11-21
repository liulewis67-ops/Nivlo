import { describe, expect, it } from "vitest";
import type { TodayItemDto, TodayViewDto } from "@/lib/ipc";
import { applyCompleted, applyMove, applyPostponed, applyReopened, findTodo } from "./today-view";

/** 构造一个待办条目。 */
function todo(id: string, isOverdue = false): TodayItemDto {
  return {
    id,
    itemType: "todo",
    title: id,
    brief: null,
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

describe("applyMove", () => {
  it("向下拖动：放到目标位置，其余顺序不变", () => {
    expect(applyMove(VIEW, "a", "c").todos.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("向上拖动", () => {
    expect(applyMove(VIEW, "c", "a").todos.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("位置没变或 ID 无效时原样返回", () => {
    expect(applyMove(VIEW, "a", "a")).toBe(VIEW);
    expect(applyMove(VIEW, "a", "zzz")).toBe(VIEW);
    expect(applyMove(VIEW, "zzz", "a")).toBe(VIEW);
  });
});

describe("applyPostponed", () => {
  it("移出待办、计数减一，已完成区不受影响", () => {
    const next = applyPostponed(VIEW, "b");
    expect(next.todos.map((t) => t.id)).toEqual(["a", "c"]);
    expect(next.remainingCount).toBe(2);
    expect(next.completed).toEqual([]);
  });

  it("推迟后撤销能放回原位", () => {
    const position = findTodo(VIEW, "b");
    if (position === null) throw new Error("not found");
    const back = applyReopened(applyPostponed(VIEW, "b"), position.item, position.index);
    expect(back).toEqual(VIEW);
  });

  it("不在待办里的 ID 原样返回", () => {
    expect(applyPostponed(VIEW, "zzz")).toBe(VIEW);
  });

  it("勾掉提示：移出提示、进入已完成、计数减一；撤销后回到提示的原位", () => {
    const tip = (id: string): TodayItemDto => ({ ...todo(id), itemType: "tip" });
    const view: TodayViewDto = { ...VIEW, remainingCount: 5, tips: [tip("t1"), tip("t2")] };

    const done = applyCompleted(view, "t1");
    expect(done.tips.map((t) => t.id)).toEqual(["t2"]);
    expect(done.todos).toEqual(view.todos);
    expect(done.completed.map((t) => [t.id, t.status])).toEqual([["t1", "done"]]);
    expect(done.remainingCount).toBe(4);

    const undone = applyReopened(done, tip("t1"), 0);
    expect(undone.tips.map((t) => [t.id, t.status])).toEqual([
      ["t1", "open"],
      ["t2", "open"],
    ]);
    expect(undone.todos).toEqual(view.todos);
    expect(undone.completed).toEqual([]);
    expect(undone.remainingCount).toBe(5);
  });
});
