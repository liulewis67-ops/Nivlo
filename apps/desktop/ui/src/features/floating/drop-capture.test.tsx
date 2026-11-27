import { act, createEvent, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_VISIBLE_MS } from "@/features/capture";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { FloatingRoot } from "./FloatingRoot";
import { HOVER_ENTER_DELAY_MS, HOVER_LEAVE_DELAY_MS } from "./model/floating-machine";

/** 悬浮窗根元素。 */
function root(): HTMLElement {
  return screen.getByRole("group", { name: "StarAt悬浮窗" });
}

/** 推进虚拟时间并让挂起的 Promise 完成。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 构造一个拖放用的 dataTransfer。 */
function transfer(data: Record<string, string>, files: File[] = []) {
  return {
    types: [...Object.keys(data), ...(files.length > 0 ? ["Files"] : [])],
    getData: (format: string) => data[format] ?? "",
    files,
    dropEffect: "none",
  };
}

/** 拖入悬浮窗并松在「直接收进收集箱」区（原来的立即捕获）。 */
async function dropOnInbox(dataTransfer: ReturnType<typeof transfer>): Promise<void> {
  fireEvent.dragEnter(root(), { dataTransfer });
  await advance(0);
  const zone = screen.getByText("直接收进收集箱").closest("[data-drop-zone]");
  if (zone === null) throw new Error("没有收集箱放置区");
  fireEvent.dragOver(zone, { dataTransfer });
  fireEvent.drop(zone, { dataTransfer });
}

describe("拖放捕获（悬浮窗）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("拖入立即展开并显示两个放置区，指针所在的区域高亮，拖出后消失", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    const dataTransfer = transfer({ "text/plain": "hi" });

    fireEvent.dragEnter(root(), { dataTransfer });
    await advance(0);
    const create = screen.getByText("新建事项…").closest("[data-drop-zone]");
    const inbox = screen.getByText("直接收进收集箱").closest("[data-drop-zone]");
    expect(ipc.lastExpand).not.toBeNull();
    // 默认高亮「新建事项」；移到收集箱区后换成它。
    expect(create).toHaveAttribute("data-active", "true");
    if (inbox === null) throw new Error("没有收集箱放置区");
    fireEvent.dragOver(inbox, { dataTransfer });
    expect(inbox).toHaveAttribute("data-active", "true");
    expect(create).toHaveAttribute("data-active", "false");

    fireEvent.dragLeave(root(), { dataTransfer });
    await advance(0);
    expect(screen.queryByText("新建事项…")).not.toBeInTheDocument();
  });

  it("放下链接：创建笔记并显示「已创建」，面板保持展开直到反馈消失", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    const dataTransfer = transfer({ "text/uri-list": "https://example.com/a" });

    await dropOnInbox(dataTransfer);
    await advance(0);

    expect(ipc.captures).toEqual([
      {
        input: { kind: "text", text: "https://example.com/a" },
        origin: "drop",
        sourceApplication: null,
      },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("已创建：https://example.com/a");
    expect(ipc.items[0]).toMatchObject({ itemType: "note", inInbox: true });

    // 指针不在窗口内：面板也不能在反馈期间收起。
    await advance(HOVER_LEAVE_DELAY_MS * 3);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(ipc.calls).not.toContain("collapseFloating");

    await advance(FEEDBACK_VISIBLE_MS);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await advance(HOVER_LEAVE_DELAY_MS);
    expect(ipc.calls).toContain("collapseFloating");
  });

  it("放下文本创建待办；点「撤销」后记录被删除、反馈关闭", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await dropOnInbox(transfer({ "text/plain": "整理周报" }));
    await advance(0);
    expect(ipc.items[0]).toMatchObject({ itemType: "todo", title: "整理周报" });

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await advance(0);
    expect(ipc.undoneCaptures).toHaveLength(1);
    expect(ipc.items).toHaveLength(0);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("点「查看」按 ID 打开事项，仍可撤销", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await dropOnInbox(transfer({ "text/plain": "x" }));
    await advance(0);

    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await advance(0);
    expect(ipc.openedItems).toEqual([ipc.items[0]?.id]);
    expect(screen.getByRole("button", { name: "撤销" })).toBeInTheDocument();
  });

  it("指针停在反馈上时不会自动消失，移开后才重新计时", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await dropOnInbox(transfer({ "text/plain": "x" }));
    await advance(0);

    const bar = screen.getByRole("status");
    fireEvent.pointerEnter(bar);
    await advance(FEEDBACK_VISIBLE_MS * 2);
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.pointerLeave(bar);
    await advance(FEEDBACK_VISIBLE_MS);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("拖来的非图片文件拿不到路径：明确提示，不创建任何东西", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    const file = new File(["x"], "报告.pdf", { type: "application/pdf" });
    fireEvent.drop(root(), { dataTransfer: transfer({}, [file]) });
    await advance(0);

    expect(screen.getByRole("status")).toHaveTextContent("没能读到这些文件在磁盘上的位置");
    expect(ipc.captures).toHaveLength(0);
  });

  it("捕获失败：显示原因，并且仍会自动消失", async () => {
    const ipc = createMemoryIpc();
    const { AppError } = await import("@/lib/errors");
    ipc.failNextCaptureWith(new AppError("STORAGE_UNAVAILABLE", "磁盘已满"));
    renderWithProviders(<FloatingRoot />, ipc);
    await dropOnInbox(transfer({ "text/plain": "x" }));
    await advance(0);

    expect(screen.getByRole("status")).toHaveTextContent("没能收集：本地数据库暂时不可用。");
    await advance(FEEDBACK_VISIBLE_MS);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("没有任何可拖放类型（例如拖动页面内元素）时不响应", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.dragEnter(root(), { dataTransfer: transfer({}) });
    await advance(0);
    expect(screen.queryByText("新建事项…")).not.toBeInTheDocument();
  });

  it("面板上显示收集箱数量，点击后请求主窗口打开收集箱", async () => {
    const ipc = createMemoryIpc();
    await ipc.capture({
      input: { kind: "text", text: "待整理" },
      origin: "drop",
      sourceApplication: null,
    });
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    fireEvent.click(screen.getByRole("button", { name: "收集箱 1" }));
    await advance(0);
    expect(ipc.openedViews).toEqual(["inbox"]);
  });

  it("收集箱是空的时不显示入口", async () => {
    renderWithProviders(<FloatingRoot />, createMemoryIpc());
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);
    expect(screen.queryByRole("button", { name: /^收集箱/ })).not.toBeInTheDocument();
  });

  it("点「粘贴」：读取剪贴板收进收集箱，并显示可撤销的反馈", async () => {
    const ipc = createMemoryIpc();
    ipc.setClipboard({ text: "https://example.com/a" });
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    fireEvent.click(screen.getByRole("button", { name: "粘贴到收集箱" }));
    await advance(0);
    expect(ipc.calls.filter((call) => call === "captureFromClipboard")).toHaveLength(1);
    expect(ipc.captures[0]).toMatchObject({ origin: "paste" });
    expect(screen.getByRole("status")).toHaveTextContent("已创建：https://example.com/a");

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await advance(0);
    expect(ipc.items).toHaveLength(0);
  });

  it("剪贴板是空的：反馈里说明原因，不创建任何东西", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);

    fireEvent.click(screen.getByRole("button", { name: "粘贴到收集箱" }));
    await advance(0);
    expect(screen.getByRole("status")).toHaveTextContent("剪贴板里没有可以收集的内容");
    expect(ipc.items).toHaveLength(0);
  });

  it("只有用户点了粘贴才读取剪贴板：悬停、拖放、快速创建都不会读取", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    fireEvent.pointerEnter(root());
    await advance(HOVER_ENTER_DELAY_MS);
    fireEvent.drop(root(), { dataTransfer: transfer({ "text/plain": "x" }) });
    await advance(0);
    act(() => ipc.emitQuickAddRequested());
    await advance(0);
    expect(ipc.calls).not.toContain("captureFromClipboard");
  });

  it("配置页粘贴文字是普通输入；文件 / 图片收进收集箱并保留配置页", async () => {
    const ipc = createMemoryIpc();
    ipc.setClipboard({ files: ["C:\\资料\\报告.pdf"] });
    renderWithProviders(<FloatingRoot />, ipc);
    act(() => ipc.emitQuickAddRequested());
    await advance(0);
    const input = screen.getByLabelText("标题");

    // 纯文字：不拦截，由输入框自己处理（没有读取剪贴板）。
    const textPaste = createEvent.paste(input, {
      clipboardData: { getData: () => "一些文字", types: ["text/plain"] },
    });
    fireEvent(input, textPaste);
    expect(textPaste.defaultPrevented).toBe(false);
    expect(ipc.calls).not.toContain("captureFromClipboard");

    // 没有文字（文件）：拦截并收进收集箱。
    const filePaste = createEvent.paste(input, {
      clipboardData: { getData: () => "", types: ["Files"] },
    });
    fireEvent(input, filePaste);
    await advance(0);
    expect(filePaste.defaultPrevented).toBe(true);
    expect(ipc.calls).toContain("captureFromClipboard");
    expect(ipc.captures[0]?.input).toMatchObject({ kind: "files" });
    expect(screen.getByLabelText("标题")).toBeInTheDocument();
  });
});
