import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayItemDto } from "@/lib/ipc";
import { useAppearanceStore } from "@/stores/appearance-store";
import { DEFAULT_SKIN, useSkinStore } from "@/stores/skin-store";
import { EMPTY_TODAY, createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { FloatingRoot, PANEL_HEIGHT_PX, PANEL_WIDTH_PX } from "./FloatingRoot";
import { HOVER_ENTER_DELAY_MS, HOVER_LEAVE_DELAY_MS } from "./model/floating-machine";

/** 悬浮窗根元素（同时是徽标与面板的容器，展开 / 收起时都存在）。 */
function root(): HTMLElement {
  return screen.getByRole("group", { name: "StarDeskBox悬浮窗" });
}

/** 推进虚拟时间并让挂起的 Promise 完成。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 构造一个 Today 待办条目。 */
function todoDto(id: string, title: string, isOverdue: boolean): TodayItemDto {
  return {
    id,
    itemType: "todo",
    title,
    brief: null,
    status: "open",
    priority: "none",
    scheduled: { date: "2026-10-10", time: null },
    due: null,
    isOverdue,
  };
}

/** 构造一个 Today 提示条目（带时间）。 */
function tipDto(id: string, title: string, time: string): TodayItemDto {
  return {
    id,
    itemType: "tip",
    title,
    brief: null,
    status: "open",
    priority: "none",
    scheduled: { date: "2026-10-10", time },
    due: null,
    isOverdue: false,
  };
}

describe("FloatingRoot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    useAppearanceStore.getState().reset();
    useSkinStore.getState().adopt(DEFAULT_SKIN);
  });

  it("到点提醒让徽标进入提醒状态，不展开窗口，并按最后一次提醒的时间停止", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);

    act(() => ipc.emitReminderAttention(8_000));
    expect(root()).toHaveAttribute("data-reminder-attention");
    expect(screen.getByText("有事项到点提醒")).toBeInTheDocument();
    expect(ipc.calls).not.toContain("expandFloating");
    expect(ipc.calls).not.toContain("openMain");

    await advance(6_000);
    act(() => ipc.emitReminderAttention(8_000));
    await advance(2_000);
    expect(root()).toHaveAttribute("data-reminder-attention");
    await advance(6_000);
    expect(root()).not.toHaveAttribute("data-reminder-attention");
    expect(screen.queryByText("有事项到点提醒")).not.toBeInTheDocument();
  });

  it("默认机器人沿用启动尺寸；切换到经典徽标时使用所选徽标尺寸", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);
    expect(ipc.calls).not.toContain("collapseFloating");

    act(() => useAppearanceStore.getState().update({ badgeShape: "circle" }));
    await advance(0);
    expect(ipc.lastCollapse).toBeNull();

    act(() => useSkinStore.getState().adopt({ ...DEFAULT_SKIN, mode: "badge" }));
    await advance(0);
    expect(ipc.lastCollapse).toEqual({ width: 36, height: 36 });
  });

  it("实时调整收起态尺寸；展开期间的调整在收起时生效", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);
    act(() => useAppearanceStore.getState().update({ badgeScale: 75 }));
    await advance(0);
    expect(ipc.lastCollapse).toEqual({ width: 60, height: 30 });
    expect(screen.getByRole("button", { name: /打开StarDeskBox主窗口/ })).toHaveStyle({
      zoom: "0.75",
    });

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);
    act(() => useAppearanceStore.getState().update({ badgeScale: 150 }));
    await advance(0);
    expect(ipc.calls.filter((call) => call === "expandFloating")).toHaveLength(1);
    expect(ipc.lastCollapse).toEqual({ width: 60, height: 30 });

    fireEvent.pointerLeave(root());
    await advance(HOVER_LEAVE_DELAY_MS);
    expect(ipc.lastCollapse).toEqual({ width: 120, height: 60 });
  });

  it("右键徽标直接进入待办的快速创建", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);

    fireEvent.contextMenu(screen.getByRole("button", { name: /打开StarDeskBox主窗口/ }));
    await advance(0);

    expect(ipc.calls).toContain("beginFloatingInput");
    expect(screen.getByRole("dialog", { name: "新增事项" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "标题" })).toBeInTheDocument();
  });

  it("全局快捷键预填选区，但不会覆盖已编辑的草稿或立即创建事项", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);

    act(() =>
      ipc.emitContextCreateRequested({ text: "跟进报价\n抄送项目组", source: "selection" }),
    );
    await advance(0);
    const title = screen.getByRole("textbox", { name: "标题" });
    expect(title).toHaveValue("跟进报价");
    expect(title).toHaveFocus();
    expect(screen.getByText("来自当前选区")).toBeInTheDocument();
    expect(screen.getByLabelText("描述")).toHaveValue("跟进报价\n抄送项目组");
    expect(screen.getByRole("button", { name: "收集箱" })).toHaveAttribute("aria-pressed", "true");
    expect(ipc.items).toHaveLength(0);

    fireEvent.change(title, { target: { value: "新版报价" } });
    act(() => ipc.emitContextCreateRequested({ text: "补上合同链接", source: "clipboard" }));
    await advance(0);
    expect(title).toHaveValue("新版报价");
    fireEvent.click(screen.getByRole("button", { name: "追加到内容" }));
    expect(screen.getByLabelText("描述")).toHaveValue("跟进报价\n抄送项目组\n\n补上合同链接");
    expect(ipc.items).toHaveLength(0);
  });

  it("Esc 关闭尚未编辑的快捷键预填窗", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);
    act(() => ipc.emitContextCreateRequested({ text: "临时消息", source: "clipboard" }));
    await advance(0);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "标题" }), { key: "Escape" });
    await advance(0);
    expect(screen.queryByRole("dialog", { name: "新增事项" })).not.toBeInTheDocument();
    expect(ipc.items).toHaveLength(0);
  });

  it("Hover 延迟之后展开为面板，并请求 Rust 把窗口调整为面板大小", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS - 1);
    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();

    await advance(1);
    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
    expect(ipc.lastExpand).toEqual({ width: PANEL_WIDTH_PX, height: PANEL_HEIGHT_PX });
  });

  it("在徽标上按住（准备拖动）时不展开；拖动结束、指针再移动后照常展开", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS - 50);
    fireEvent.pointerDown(root(), { button: 0 });
    fireEvent.pointerMove(root(), { buttons: 1 });
    await advance(HOVER_ENTER_DELAY_MS * 4);
    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();

    // 原生拖动结束时收不到 pointerup：下一次移动已经没有按键按着，就当作松开。
    fireEvent.pointerMove(root(), { buttons: 0 });
    await advance(HOVER_ENTER_DELAY_MS);
    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
  });

  it("Hover 展开与收起期间不再发起业务数据 IPC：Today 与 Inbox 数量只在启动时各取一次，之后只有窗口几何命令", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);
    fireEvent.pointerLeave(root());
    await advance(HOVER_LEAVE_DELAY_MS);

    expect(ipc.calls).toEqual(["getToday", "getInboxCount", "expandFloating", "collapseFloating"]);
  });

  it("鼠标只是路过（展开前就离开）不会发起任何 IPC", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS - 100);
    fireEvent.pointerLeave(root());
    await advance(5000);

    expect(ipc.calls).toEqual(["getToday", "getInboxCount"]);
  });

  it("离开后延迟收起，再次进入会取消收起", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    fireEvent.pointerLeave(root());
    await advance(HOVER_LEAVE_DELAY_MS - 100);
    fireEvent.pointerEnter(root());
    await advance(5000);

    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
    expect(ipc.calls).toEqual(["getToday", "getInboxCount", "expandFloating"]);
  });

  it("类型组内用方向键选择；标题里的 Tab 与方向键不更改类型", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    act(() => ipc.emitQuickAddRequested());
    await advance(0);

    const input = screen.getByLabelText("标题");
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "待办" })).toBeChecked();
    const todo = screen.getByRole("radio", { name: "待办" });
    todo.focus();
    fireEvent.keyDown(todo, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "提示" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "提示" })).toHaveFocus();

    fireEvent.change(input, { target: { value: "喝水" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await advance(0);
    expect(ipc.items[0]).toMatchObject({ itemType: "tip", title: "喝水" });
  });

  it("面板收起后回到徽标", async () => {
    renderWithProviders(<FloatingRoot />, createMemoryIpc());
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);
    fireEvent.pointerLeave(root());
    await advance(HOVER_LEAVE_DELAY_MS);

    expect(screen.getByRole("button", { name: /打开StarDeskBox主窗口/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();
  });

  it("展开命令失败时弹出错误提示，不会崩溃", async () => {
    const ipc = createMemoryIpc();
    const failing = {
      ...ipc,
      expandFloating: () => Promise.reject(new Error("window gone")),
    };
    renderWithProviders(<FloatingRoot />, failing);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    await advance(0);

    expect(screen.getByRole("alert")).toHaveTextContent("出了点问题");
  });

  it("后端补发「指针已离开」时同样延迟收起（WebView 漏发 pointerleave 的兜底）", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    // DOM 没有 pointerleave，只有后端事件。
    act(() => ipc.emitFloatingPointerLeft());
    await advance(HOVER_LEAVE_DELAY_MS - 1);
    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
    await advance(1);

    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();
    expect(ipc.calls).toEqual(["getToday", "getInboxCount", "expandFloating", "collapseFloating"]);
  });

  it("补发离开之后指针又在窗口内移动，会取消收起", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    act(() => ipc.emitFloatingPointerLeft());
    await advance(HOVER_LEAVE_DELAY_MS - 100);
    fireEvent.pointerMove(root());
    await advance(5000);

    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
  });

  it("Today 在启动时取一次并缓存，Hover 展开多次也不会再次取数", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);

    for (let i = 0; i < 3; i += 1) {
      fireEvent.pointerEnter(root());
      await advance(HOVER_ENTER_DELAY_MS);
      fireEvent.pointerLeave(root());
      await advance(HOVER_LEAVE_DELAY_MS);
    }

    expect(ipc.calls.filter((call) => call === "getToday")).toHaveLength(1);
  });

  it("后端数据变更事件让缓存失效并重新取数，徽标数字随之更新", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday({ ...EMPTY_TODAY, remainingCount: 4 });
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);
    expect(screen.getByRole("button", { name: /今天还剩 4 件事/ })).toBeInTheDocument();

    ipc.setToday({ ...EMPTY_TODAY, remainingCount: 3 });
    act(() => ipc.emitDataChange());
    await advance(0);

    expect(screen.getByRole("button", { name: /今天还剩 3 件事/ })).toBeInTheDocument();
    expect(ipc.calls.filter((call) => call === "getToday")).toHaveLength(2);
  });

  it("Today 尚未加载完成时徽标显示占位而不是 0", () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    expect(screen.getByRole("button", { name: "打开StarDeskBox主窗口" })).toBeInTheDocument();
  });

  it("展开后面板显示 Today 的待办、提示与已完成", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday({
      ...EMPTY_TODAY,
      remainingCount: 1,
      todos: [todoDto("1", "修复登录超时", true)],
      tips: [tipDto("2", "提交周报", "15:00:00")],
      completed: [{ ...todoDto("3", "写周报", false), status: "done" }],
    });
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    expect(screen.getByText("修复登录超时")).toBeInTheDocument();
    expect(screen.getByText("逾期")).toBeInTheDocument();
    expect(screen.getByText("提交周报")).toBeInTheDocument();
    expect(screen.getByText("15:00")).toBeInTheDocument();
    expect(screen.getByText("写周报")).toBeInTheDocument();
    expect(screen.queryByText("今天还没有安排")).not.toBeInTheDocument();
  });

  it("没有任何事项时显示空状态", async () => {
    renderWithProviders(<FloatingRoot />, createMemoryIpc());
    await advance(0);

    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    expect(screen.getByText("今天还没有安排")).toBeInTheDocument();
  });

  /** 把悬浮窗展开到面板态。 */
  async function openPanel(ipc: ReturnType<typeof createMemoryIpc>): Promise<void> {
    renderWithProviders(<FloatingRoot />, ipc);
    await advance(0);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);
  }

  it("新增打开完整配置，Ctrl+Enter 创建后恢复 Today 面板", async () => {
    const ipc = createMemoryIpc();
    await openPanel(ipc);

    fireEvent.click(screen.getByRole("button", { name: "+ 待办" }));
    await advance(0);
    const input = screen.getByRole("textbox", { name: "标题" });
    fireEvent.change(input, { target: { value: "写周报" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await advance(0);

    // 除了 Today 的刷新之外，调用顺序是：展开 → 申请焦点 → 创建 → 归还焦点。
    expect(
      ipc.calls.filter((call) => !["getToday", "getInboxCount", "listProjects"].includes(call)),
    ).toEqual([
      "expandFloating",
      "beginFloatingInput",
      "createItem",
      "endFloatingInput",
      "expandFloating",
    ]);
    // Today 在启动时取一次，创建成功后由数据变更事件触发再取一次。
    expect(ipc.calls.filter((call) => call === "getToday")).toHaveLength(2);
    expect(ipc.items.map((item) => item.title)).toEqual(["写周报"]);
    // 回到展开态：输入行消失、添加按钮回来、面板仍在。
    expect(screen.queryByRole("textbox", { name: "标题" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 待办" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
  });

  it("配置页失焦时保留输入，不创建任何条目", async () => {
    const ipc = createMemoryIpc();
    await openPanel(ipc);
    fireEvent.click(screen.getByRole("button", { name: "+ 待办" }));
    await advance(0);
    fireEvent.change(screen.getByRole("textbox", { name: "标题" }), {
      target: { value: "半句话" },
    });

    act(() => {
      window.dispatchEvent(new FocusEvent("blur"));
    });
    await advance(0);

    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("半句话");
    expect(ipc.calls).not.toContain("endFloatingInput");
    expect(ipc.items).toHaveLength(0);
  });

  it("三个按钮分别创建待办、笔记与提示", async () => {
    const ipc = createMemoryIpc();
    await openPanel(ipc);

    for (const [label, title] of [
      ["+ 笔记", "一个想法"],
      ["+ 提示", "服务器维护"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await advance(0);
      const input = screen.getByRole("textbox", { name: "标题" });
      fireEvent.change(input, { target: { value: title } });
      fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
      await advance(0);
    }

    expect(ipc.items.map((item) => [item.itemType, item.title])).toEqual([
      ["note", "一个想法"],
      ["tip", "服务器维护"],
    ]);
  });

  it("快速创建期间指针离开不会收起面板；取消后再延迟收起", async () => {
    const ipc = createMemoryIpc();
    await openPanel(ipc);
    fireEvent.click(screen.getByRole("button", { name: "+ 待办" }));
    await advance(0);

    fireEvent.pointerLeave(root());
    await advance(10_000);
    expect(screen.getByRole("dialog", { name: "新增事项" })).toBeInTheDocument();
    expect(ipc.calls).not.toContain("collapseFloating");

    fireEvent.keyDown(screen.getByRole("textbox", { name: "标题" }), { key: "Escape" });
    await advance(0);
    // 取消后指针已经在外面：先回到展开态，延迟之后才收起。
    expect(screen.getByRole("region", { name: "今日面板" })).toBeInTheDocument();
    await advance(HOVER_LEAVE_DELAY_MS);

    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();
    expect(ipc.calls).toContain("endFloatingInput");
    expect(ipc.calls).toContain("collapseFloating");
    expect(ipc.items).toHaveLength(0);
  });
});

describe("托盘快速添加", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("收到事件时直接展开并进入待办的快速创建，不需要 Hover", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    expect(screen.queryByRole("region", { name: "今日面板" })).not.toBeInTheDocument();

    act(() => {
      ipc.emitQuickAddRequested();
    });
    await advance(0);

    expect(screen.getByRole("dialog", { name: "新增事项" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "标题" })).toBeInTheDocument();
    expect(ipc.calls).toContain("beginFloatingInput");
  });

  it("配置页已打开时再次请求只取回焦点，保留草稿与所选类型", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    act(() => ipc.emitQuickAddRequested());
    await advance(0);
    fireEvent.click(screen.getByRole("radio", { name: "笔记" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "进行中的草稿" } });
    screen.getByRole("radio", { name: "笔记" }).focus();
    const begin = vi.spyOn(ipc, "beginFloatingInput");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    act(() => ipc.emitQuickAddRequested());
    await advance(0);

    expect(begin).toHaveBeenCalledWith(true, true);
    expect(screen.getByLabelText("标题")).toHaveFocus();
    expect(screen.getByLabelText("标题")).toHaveValue("进行中的草稿");
    expect(screen.getByRole("radio", { name: "笔记" })).toBeChecked();
    hasFocus.mockRestore();
  });
});
