import { screen, within } from "@testing-library/react";
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
