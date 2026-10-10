import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { TodayItemDto, TodayViewDto } from "@/lib/ipc";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { MainShell } from "./MainShell";
import { useNavStore } from "./nav-store";

/** 构造一个待办条目。 */
function todo(id: string, title: string): TodayItemDto {
  return {
    id,
    itemType: "todo",
    title,
    status: "open",
    priority: "none",
    scheduled: { date: "2026-10-10", time: null },
    due: null,
    isOverdue: false,
  };
}

/** 两条待办、一条已完成的 Today 视图。 */
const VIEW: TodayViewDto = {
  date: "2026-10-10",
  remainingCount: 2,
  todos: [todo("a", "写周报"), todo("b", "回邮件")],
  tips: [],
  completed: [{ ...todo("c", "站会"), status: "done" }],
};

describe("MainShell", () => {
  beforeEach(() => {
    useNavStore.setState({ view: "today" });
    useToastStore.setState({ toasts: [] });
  });

  it("默认显示 Today，导航栏标出当前页并显示剩余待办数", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    renderWithProviders(<MainShell />, ipc);

    expect(await screen.findByRole("region", { name: "今天" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("button", { name: /今天/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await waitFor(() =>
      expect(within(nav).getByRole("button", { name: /今天/ })).toHaveTextContent("2"),
    );
  });

  it("尚未实现的页面显示占位说明，切回 Today 后内容仍在", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    renderWithProviders(<MainShell />, ipc);
    await screen.findByText("写周报");

    await user.click(screen.getByRole("button", { name: "收集箱" }));
    expect(screen.getByRole("heading", { name: "收集箱" })).toBeInTheDocument();
    expect(screen.getByText(/拖进来、粘贴进来/)).toBeInTheDocument();
    expect(screen.queryByText("写周报")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /今天/ }));
    expect(await screen.findByText("写周报")).toBeInTheDocument();
  });

  it("显示进度，并在输入框里回车创建待办", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    renderWithProviders(<MainShell />, ipc);
    await screen.findByText("写周报");

    // 1 个已完成、2 个未完成。
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "3");
    expect(screen.getByText("还剩 2 项")).toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "添加待办" });
    await user.type(input, "  整理发票 {Enter}");

    await waitFor(() => expect(ipc.items.map((item) => item.title)).toEqual(["整理发票"]));
    expect(ipc.items[0]?.itemType).toBe("todo");
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("空标题不会提交", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    renderWithProviders(<MainShell />, ipc);
    await screen.findByText("今天还没有安排");

    await user.type(screen.getByRole("textbox", { name: "添加待办" }), "   {Enter}");

    expect(ipc.calls).not.toContain("quickCreate");
  });

  it("在主窗口完成待办会调用后端；后端数据变化事件会刷新列表（与悬浮窗同步的同一机制）", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    renderWithProviders(<MainShell />, ipc);
    await screen.findByText("写周报");

    fireEvent.click(screen.getByRole("checkbox", { name: "完成「写周报」" }));
    await waitFor(() => expect(ipc.calls).toContain("completeItem"));

    // 另一个窗口（悬浮窗）新增了一条：事件到达后主窗口的列表自动出现它。
    ipc.setToday({
      ...VIEW,
      remainingCount: 2,
      todos: [todo("b", "回邮件"), todo("d", "悬浮窗里新建的")],
    });
    act(() => {
      ipc.emitDataChange();
    });
    expect(await screen.findByText("悬浮窗里新建的")).toBeInTheDocument();
  });
});
