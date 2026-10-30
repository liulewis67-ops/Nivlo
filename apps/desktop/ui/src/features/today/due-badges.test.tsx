import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { TodayItemDto, TodayViewDto } from "@/lib/ipc";
import { renderWithProviders } from "@/test/render";
import { TodayList } from "./TodayList";

/** 构造一个待办，可带截止日期与计划时间。 */
function todo(id: string, title: string, due: string | null): TodayItemDto {
  return {
    id,
    itemType: "todo",
    title,
    status: "open",
    priority: "none",
    scheduled: { date: "2026-10-10", time: null },
    due: due === null ? null : { date: due, time: null },
    isOverdue: false,
  };
}

const VIEW: TodayViewDto = {
  date: "2026-10-10",
  remainingCount: 5,
  todos: [
    todo("a", "已过截止", "2026-10-08"),
    todo("b", "今天截止", "2026-10-10"),
    todo("c", "明天截止", "2026-10-11"),
    todo("d", "下周截止", "2026-10-17"),
    todo("e", "没有截止", null),
  ],
  tips: [
    {
      id: "t",
      itemType: "tip",
      title: "提交周报",
      status: "open",
      priority: "none",
      scheduled: { date: "2026-10-10", time: "15:00:00" },
      due: null,
      isOverdue: false,
    },
  ],
  completed: [],
};

describe("Today 里的截止与时间标记（悬浮窗与主窗口共用同一个列表）", () => {
  it("已过截止、今天截止、明天截止各有标记，更远的与没有截止的没有", () => {
    renderWithProviders(
      <TodayList
        view={VIEW}
        onComplete={() => undefined}
        onMove={() => undefined}
        onPostpone={() => undefined}
        onReopen={() => undefined}
      />,
    );
    const todos = screen.getByRole("list", { name: "待办" });
    const rowOf = (title: string) => {
      const row = within(todos)
        .getAllByRole("listitem")
        .find((li) => li.textContent?.includes(title));
      if (row === undefined) throw new Error(title);
      return row;
    };
    expect(
      within(rowOf("已过截止")).getByText("已过截止", { selector: "span.border" }),
    ).toBeInTheDocument();
    expect(
      within(rowOf("今天截止")).getByText("今天截止", { selector: "span.border" }),
    ).toBeInTheDocument();
    expect(
      within(rowOf("明天截止")).getByText("明天截止", { selector: "span.border" }),
    ).toBeInTheDocument();
    expect(within(rowOf("下周截止")).queryByText(/截止$/, { selector: "span.border" })).toBeNull();
    expect(within(rowOf("没有截止")).queryByText(/截止$/, { selector: "span.border" })).toBeNull();
  });

  it("Tip 显示 💡 与具体时间", () => {
    renderWithProviders(
      <TodayList
        view={VIEW}
        onComplete={() => undefined}
        onMove={() => undefined}
        onPostpone={() => undefined}
        onReopen={() => undefined}
      />,
    );
    const tips = screen.getByRole("list", { name: "提示" });
    expect(tips).toHaveTextContent("💡");
    expect(tips).toHaveTextContent("15:00");
    expect(tips).toHaveTextContent("提交周报");
  });
});

describe("隐藏已完成", () => {
  it("开启后不显示已完成区，关闭后恢复", async () => {
    const { useDisplayStore } = await import("@/stores/display-store");
    const view: TodayViewDto = {
      ...VIEW,
      completed: [{ ...todo("z", "已经做完", null), status: "done" }],
    };
    const props = {
      view,
      onComplete: () => undefined,
      onMove: () => undefined,
      onPostpone: () => undefined,
      onReopen: () => undefined,
    };
    useDisplayStore.setState({ hideCompleted: true });
    const hidden = renderWithProviders(<TodayList {...props} />);
    expect(screen.queryByText("已经做完")).toBeNull();
    hidden.unmount();
    useDisplayStore.setState({ hideCompleted: false });
    renderWithProviders(<TodayList {...props} />);
    expect(screen.getByText("已经做完")).toBeTruthy();
  });
});

describe("Today 里待办的具体时间", () => {
  it("今天带时间的待办在标题前显示时间；全天的与逾期的不显示", () => {
    const timed: TodayItemDto = {
      ...todo("x", "评审方案", null),
      scheduled: { date: "2026-10-10", time: "15:00:00" },
    };
    const overdue: TodayItemDto = {
      ...todo("y", "昨天的会", null),
      scheduled: { date: "2026-10-09", time: "09:30:00" },
      isOverdue: true,
    };
    renderWithProviders(
      <TodayList
        view={{ ...VIEW, todos: [timed, overdue, todo("z", "全天的事", null)], tips: [] }}
        onComplete={() => undefined}
        onMove={() => undefined}
        onPostpone={() => undefined}
        onReopen={() => undefined}
      />,
    );
    const rows = within(screen.getByRole("list", { name: "待办" })).getAllByRole("listitem");
    const textOf = (title: string) =>
      rows.find((row) => row.textContent?.includes(title))?.textContent ?? "";
    expect(textOf("评审方案")).toContain("15:00评审方案");
    expect(textOf("昨天的会")).not.toContain("09:30");
    expect(textOf("全天的事")).not.toMatch(/\d\d:\d\d/);
  });
});

describe("Today 里的键盘移动", () => {
  it("在完成框上按 ↑ / ↓ 移到上一条 / 下一条的完成框", () => {
    renderWithProviders(
      <TodayList
        view={VIEW}
        onComplete={() => undefined}
        onMove={() => undefined}
        onPostpone={() => undefined}
        onReopen={() => undefined}
      />,
    );
    const boxes = within(screen.getByRole("list", { name: "待办" })).getAllByRole("checkbox");
    boxes[0]?.focus();
    fireEvent.keyDown(boxes[0] as HTMLElement, { key: "ArrowDown" });
    expect(boxes[1]).toHaveFocus();
    fireEvent.keyDown(boxes[1] as HTMLElement, { key: "ArrowUp" });
    expect(boxes[0]).toHaveFocus();
  });

  it("完成一条后焦点落在下一条的完成框；最后一条完成后落在上一条", () => {
    /** 完成即从列表移走，和真实的乐观更新一样。 */
    function Host() {
      const [view, setView] = useState(VIEW);
      return (
        <TodayList
          view={view}
          onComplete={(item) =>
            setView((current) => ({
              ...current,
              todos: current.todos.filter((todo) => todo.id !== item.id),
            }))
          }
          onMove={() => undefined}
          onPostpone={() => undefined}
          onReopen={() => undefined}
        />
      );
    }
    renderWithProviders(<Host />);
    const box = (title: string) => screen.getByRole("checkbox", { name: `完成「${title}」` });

    box("今天截止").focus();
    fireEvent.click(box("今天截止"));
    expect(box("明天截止")).toHaveFocus();

    box("没有截止").focus();
    fireEvent.click(box("没有截止"));
    expect(box("下周截止")).toHaveFocus();
  });

  it("在完成框上按 M 推迟到明天，焦点落在下一条", () => {
    const postponed: string[] = [];
    /** 推迟即从列表移走。 */
    function Host() {
      const [view, setView] = useState(VIEW);
      return (
        <TodayList
          view={view}
          onComplete={() => undefined}
          onMove={() => undefined}
          onPostpone={(item, kind) => {
            postponed.push(`${item.id}:${kind}`);
            setView((current) => ({
              ...current,
              todos: current.todos.filter((todo) => todo.id !== item.id),
            }));
          }}
          onReopen={() => undefined}
        />
      );
    }
    renderWithProviders(<Host />);
    const box = (title: string) => screen.getByRole("checkbox", { name: `完成「${title}」` });
    box("今天截止").focus();
    fireEvent.keyDown(box("今天截止"), { key: "m", ctrlKey: true });
    expect(postponed).toEqual([]);
    fireEvent.keyDown(box("今天截止"), { key: "m" });
    expect(postponed).toEqual(["b:tomorrow"]);
    expect(box("明天截止")).toHaveFocus();
  });

  it("在完成框上按 Delete 删除（只在给了删除回调时），焦点落在下一条", () => {
    const deleted: string[] = [];
    /** 删除即从列表移走；`deletable` 为假时模拟悬浮窗（不给删除回调）。 */
    function Host({ deletable }: { deletable: boolean }) {
      const [view, setView] = useState(VIEW);
      return (
        <TodayList
          view={view}
          onComplete={() => undefined}
          onMove={() => undefined}
          onPostpone={() => undefined}
          onReopen={() => undefined}
          onDelete={
            deletable
              ? (item) => {
                  deleted.push(item.id);
                  setView((current) => ({
                    ...current,
                    todos: current.todos.filter((todo) => todo.id !== item.id),
                  }));
                }
              : undefined
          }
        />
      );
    }
    const box = (title: string) => screen.getByRole("checkbox", { name: `完成「${title}」` });
    const floating = renderWithProviders(<Host deletable={false} />);
    fireEvent.keyDown(box("今天截止"), { key: "Delete" });
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    floating.unmount();

    renderWithProviders(<Host deletable />);
    box("今天截止").focus();
    fireEvent.keyDown(box("今天截止"), { key: "Delete" });
    expect(deleted).toEqual(["b"]);
    expect(box("明天截止")).toHaveFocus();
  });

  it("取消勾选已完成的一条后，焦点落在它回到待办列表后的完成框", () => {
    const done: TodayItemDto = { ...todo("z", "做完的", null), status: "done" };
    /** 取消勾选即回到待办列表，和真实的乐观更新一样。 */
    function Host() {
      const [view, setView] = useState<TodayViewDto>({ ...VIEW, completed: [done] });
      return (
        <TodayList
          view={view}
          onComplete={() => undefined}
          onMove={() => undefined}
          onPostpone={() => undefined}
          onReopen={(item) =>
            setView((current) => ({
              ...current,
              todos: [...current.todos, { ...item, status: "open" }],
              completed: current.completed.filter((other) => other.id !== item.id),
            }))
          }
        />
      );
    }
    renderWithProviders(<Host />);
    const reopen = screen.getByRole("checkbox", { name: "重新打开「做完的」" });
    reopen.focus();
    fireEvent.click(reopen);
    expect(screen.getByRole("checkbox", { name: "完成「做完的」" })).toHaveFocus();
  });
});
