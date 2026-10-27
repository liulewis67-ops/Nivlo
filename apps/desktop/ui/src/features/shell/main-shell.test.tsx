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

  it("全局搜索的快捷键被占用时侧栏给出提示和修改框；没被占用时侧栏不出现它", async () => {
    const ok = createMemoryIpc();
    const { unmount } = renderWithProviders(<MainShell />, ok);
    await screen.findByRole("button", { name: /快速创建：/ });
    expect(screen.queryByRole("button", { name: /全局搜索：/ })).not.toBeInTheDocument();
    unmount();

    const taken = createMemoryIpc();
    taken.setShortcutStatus(
      {
        accelerator: "Ctrl+Alt+Space",
        registered: false,
        conflict: true,
        defaultAccelerator: "Ctrl+Alt+Space",
        disabled: false,
        typesCharacter: false,
      },
      "search",
    );
    renderWithProviders(<MainShell />, taken);
    expect(await screen.findByText(/暂时无法用它呼出全局搜索/)).toBeInTheDocument();
  });

  it("切换到别的视图再切回 Today，内容仍在", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    renderWithProviders(<MainShell />, ipc);
    await screen.findByText("写周报");

    await user.click(screen.getByRole("button", { name: "日历" }));
    expect(await screen.findByRole("region", { name: "日历" })).toBeInTheDocument();
    expect(screen.queryByText("写周报")).not.toBeInTheDocument();

    await user.click(
      within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", {
        name: /今天/,
      }),
    );
    expect(await screen.findByText("写周报")).toBeInTheDocument();
  });

  it("Inbox 视图列出捕获的内容，侧栏角标显示待整理数量", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    await ipc.capture({
      input: { kind: "text", text: "https://example.com/x" },
      origin: "drop",
      sourceApplication: null,
    });
    renderWithProviders(<MainShell />, ipc);

    const nav = await screen.findByRole("button", { name: /收集箱/ });
    await waitFor(() => expect(nav).toHaveTextContent("1"));
    await user.click(nav);
    expect(await screen.findByText("example.com/x")).toBeInTheDocument();
  });

  it("悬浮窗请求打开收集箱：窗口刚创建时取走待处理请求，已在运行时响应事件", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday(VIEW);
    ipc.setPendingMainView("inbox");
    renderWithProviders(<MainShell />, ipc);
    expect(await screen.findByRole("heading", { name: "收集箱" })).toBeInTheDocument();

    act(() => ipc.emitMainViewRequested("calendar"));
    expect(await screen.findByRole("region", { name: "日历" })).toBeInTheDocument();
    // 不认识的视图被忽略。
    act(() => ipc.emitMainViewRequested("nope"));
    expect(screen.getByRole("region", { name: "日历" })).toBeInTheDocument();
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
