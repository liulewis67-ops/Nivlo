import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { OpenItemContext } from "@/features/detail";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { InboxPage } from "./InboxPage";

/** 往收集箱里放一条文本 / 网址捕获。 */
async function capture(ipc: MemoryIpc, text: string): Promise<void> {
  await ipc.capture({
    input: { kind: "text", text },
    origin: "drop",
    sourceApplication: null,
  });
}

/** 取一行（按标题）。 */
function row(title: string): HTMLElement {
  const item = screen.getByText(title).closest("li");
  if (item === null) throw new Error(`找不到「${title}」那一行`);
  return item;
}

/** 当前 Toast 上的撤销按钮。 */
function undoToast() {
  return useToastStore.getState().toasts.at(-1)?.action;
}

describe("InboxPage", () => {
  it("没有内容时显示空状态，告诉用户怎么往里放东西", async () => {
    renderWithProviders(<InboxPage />, createMemoryIpc());
    expect(await screen.findByText("收集箱是空的")).toBeInTheDocument();
    expect(screen.getByText(/拖到悬浮窗/)).toBeInTheDocument();
    expect(screen.getByText("已全部整理")).toBeInTheDocument();
  });

  it("按捕获时间从新到旧列出，显示来源说明与待整理数量", async () => {
    const ipc = createMemoryIpc();
    await capture(ipc, "https://www.example.com/docs/a");
    await capture(ipc, "整理周报");
    renderWithProviders(<InboxPage />, ipc);

    const titles = (await screen.findAllByRole("listitem")).map((li) => li.textContent ?? "");
    expect(titles[0]).toContain("整理周报");
    expect(titles[1]).toContain("example.com/docs/a");
    expect(screen.getByText("2 项待整理")).toBeInTheDocument();
  });

  it("点「今天」：条目立即离开收集箱，并给出可撤销的提示；撤销后回来", async () => {
    const ipc = createMemoryIpc();
    await capture(ipc, "整理周报");
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("整理周报");

    fireEvent.click(within(row("整理周报")).getByRole("button", { name: "今天" }));
    await waitFor(() => expect(screen.queryByText("整理周报")).not.toBeInTheDocument());
    expect(ipc.organizations).toEqual([
      { ids: [ipc.items[0]?.id], action: { kind: "schedule", target: { kind: "today" } } },
    ]);
    expect(screen.getByText("收集箱是空的")).toBeInTheDocument();

    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.message).toBe("已安排到今天（1 项）");
    act(() => undoToast()?.onClick());
    await waitFor(() => expect(screen.getByText("整理周报")).toBeInTheDocument());
    expect(ipc.restorations).toHaveLength(1);
  });

  it("更多菜单：转换类型与归档", async () => {
    const ipc = createMemoryIpc();
    await capture(ipc, "https://example.com");
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("example.com");

    fireEvent.pointerDown(
      within(row("example.com")).getByRole("button", { name: "更多整理方式" }),
      { button: 0, ctrlKey: false },
    );
    // 当前是笔记，菜单里只给另外两种类型。
    expect(await screen.findByRole("menuitem", { name: "转为待办" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "转为笔记" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));
    await waitFor(() => expect(ipc.organizations).toHaveLength(1));
    expect(ipc.organizations[0]?.action).toEqual({ kind: "archive" });
  });

  it("键盘整理：勾选后按 T 安排到今天、按 M 安排到明天（和按钮一样可撤销）；没勾选时按键不起作用", async () => {
    const ipc = createMemoryIpc();
    for (const text of ["一", "二"]) await capture(ipc, text);
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("一");

    const first = screen.getByRole("checkbox", { name: "选择：一" });
    fireEvent.keyDown(first, { key: "t" });
    expect(ipc.organizations).toHaveLength(0);

    fireEvent.click(first);
    fireEvent.keyDown(first, { key: "t" });
    await waitFor(() => expect(ipc.organizations).toHaveLength(1));
    expect(ipc.organizations[0]?.action).toEqual({ kind: "schedule", target: { kind: "today" } });
    expect(undoToast()).toBeDefined();

    const second = screen.getByRole("checkbox", { name: "选择：二" });
    fireEvent.click(second);
    fireEvent.keyDown(second, { key: "M" });
    await waitFor(() => expect(ipc.organizations).toHaveLength(2));
    expect(ipc.organizations[1]?.action).toEqual({
      kind: "schedule",
      target: { kind: "tomorrow" },
    });
  });

  it("Ctrl+A 选中全部条目，接着按 T 一次整理掉", async () => {
    const ipc = createMemoryIpc();
    for (const text of ["一", "二", "三"]) await capture(ipc, text);
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("一");
    const first = screen.getByRole("checkbox", { name: "选择：一" });
    first.focus();

    fireEvent.keyDown(first, { key: "a", ctrlKey: true });
    for (const text of ["一", "二", "三"]) {
      expect(screen.getByRole("checkbox", { name: `选择：${text}` })).toBeChecked();
    }
    // 工具栏的按钮标出了对应的按键，名称不变。
    const hinted = screen
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("aria-keyshortcuts"))
      .map((button) => [button.textContent, button.getAttribute("aria-keyshortcuts")]);
    expect(hinted).toEqual([
      ["今天T", "T"],
      ["明天M", "M"],
      ["删除Del", "Delete"],
    ]);
    expect(screen.getAllByRole("button", { name: "今天" }).length).toBeGreaterThan(1);
    fireEvent.keyDown(first, { key: "t" });
    await waitFor(() => expect(ipc.organizations).toHaveLength(1));
    expect(ipc.organizations[0]?.ids).toHaveLength(3);
  });

  it("勾选后按 Delete 移进回收站（带撤销），焦点落在下一条", async () => {
    const ipc = createMemoryIpc();
    for (const text of ["一", "二"]) await capture(ipc, text);
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("一");
    const boxes = () =>
      screen.getAllByRole("checkbox").filter((box) => box.hasAttribute("data-inbox-select"));
    const [top, bottom] = boxes();
    // 没勾选时 Delete 不起作用。
    fireEvent.keyDown(top as HTMLElement, { key: "Delete" });
    expect(ipc.calls).not.toContain("deleteItems");

    top?.focus();
    fireEvent.click(top as HTMLElement);
    fireEvent.keyDown(top as HTMLElement, { key: "Delete" });
    await waitFor(() => expect(boxes()).toHaveLength(1));
    expect(ipc.calls).toContain("deleteItems");
    expect(bottom).toHaveFocus();
    expect(useToastStore.getState().toasts.at(-1)?.action?.undo).toBe(true);
  });

  it("勾选框上按 Enter 打开详情，不会勾选", async () => {
    const ipc = createMemoryIpc();
    await capture(ipc, "一");
    const opened: string[] = [];
    renderWithProviders(
      <OpenItemContext.Provider value={(id) => opened.push(id)}>
        <InboxPage />
      </OpenItemContext.Provider>,
      ipc,
    );
    const box = await screen.findByRole("checkbox", { name: "选择：一" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(opened).toEqual([ipc.items[0]?.id]);
    expect(box).not.toBeChecked();
  });

  it("条目多时出现筛选框：只显示、只整理匹配的条目；Esc 清空，条目少了就收起", async () => {
    const ipc = createMemoryIpc();
    for (let index = 0; index < 8; index += 1) await capture(ipc, `杂项 ${index}`);
    await capture(ipc, "周报草稿");
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("周报草稿");
    // 9 条：还不显示筛选框。
    expect(screen.queryByRole("searchbox", { name: "筛选收集箱" })).not.toBeInTheDocument();
    await capture(ipc, "周报定稿");
    act(() => ipc.emitDataChange());
    const filter = await screen.findByRole("searchbox", { name: "筛选收集箱" });

    fireEvent.change(filter, { target: { value: "周报" } });
    const boxes = () =>
      screen.getAllByRole("checkbox").filter((box) => box.hasAttribute("data-inbox-select"));
    expect(boxes()).toHaveLength(2);

    // Ctrl+A 与 T 只作用于看得见的两条。
    fireEvent.keyDown(boxes()[0] as HTMLElement, { key: "a", ctrlKey: true });
    fireEvent.keyDown(boxes()[0] as HTMLElement, { key: "t" });
    await waitFor(() => expect(ipc.organizations).toHaveLength(1));
    expect(ipc.organizations[0]?.ids).toHaveLength(2);

    fireEvent.change(filter, { target: { value: "没有这个词" } });
    expect(screen.getByText("没有匹配的条目。")).toHaveAttribute("role", "status");
    fireEvent.keyDown(filter, { key: "Escape" });
    // 整理掉两条后只剩 8 条：清空筛选后筛选框收起，全部条目回来。
    expect(screen.queryByRole("searchbox", { name: "筛选收集箱" })).not.toBeInTheDocument();
    expect(boxes()).toHaveLength(8);
  });

  it("在勾选框上按 ↑ / ↓ 移到上一条 / 下一条的勾选框", async () => {
    const ipc = createMemoryIpc();
    for (const text of ["一", "二", "三"]) await capture(ipc, text);
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("一");
    const boxes = screen
      .getAllByRole("checkbox")
      .filter((box) => box.hasAttribute("data-inbox-select"));
    boxes[0]?.focus();

    fireEvent.keyDown(boxes[0] as HTMLElement, { key: "ArrowDown" });
    expect(boxes[1]).toHaveFocus();
    fireEvent.keyDown(boxes[1] as HTMLElement, { key: "ArrowUp" });
    expect(boxes[0]).toHaveFocus();
    // 第一条再往上：停在原地。
    fireEvent.keyDown(boxes[0] as HTMLElement, { key: "ArrowUp" });
    expect(boxes[0]).toHaveFocus();
  });

  it("键盘整理后焦点落在下一条的勾选框（最后一条时落在上一条），可以接着整理", async () => {
    const ipc = createMemoryIpc();
    for (const text of ["一", "二", "三"]) await capture(ipc, text);
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("一");
    const boxes = () =>
      screen.getAllByRole("checkbox").filter((box) => box.hasAttribute("data-inbox-select"));
    const [top, middle, bottom] = boxes();

    middle?.focus();
    fireEvent.click(middle as HTMLElement);
    fireEvent.keyDown(middle as HTMLElement, { key: "t" });
    await waitFor(() => expect(boxes()).toHaveLength(2));
    expect(bottom).toHaveFocus();

    fireEvent.click(bottom as HTMLElement);
    fireEvent.keyDown(bottom as HTMLElement, { key: "m" });
    await waitFor(() => expect(boxes()).toHaveLength(1));
    expect(top).toHaveFocus();
  });

  it("勾选多条后批量整理：一次调用，整批离开", async () => {
    const ipc = createMemoryIpc();
    for (const text of ["一", "二", "三"]) await capture(ipc, text);
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("一");

    fireEvent.click(screen.getByRole("checkbox", { name: "选择：三" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择：二" }));
    expect(screen.getByText("已选 2 项")).toBeInTheDocument();

    const toolbar = screen.getByRole("toolbar", { name: "批量整理" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "明天" }));
    await waitFor(() => expect(ipc.organizations).toHaveLength(1));
    expect(ipc.organizations[0]?.ids).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText("二")).not.toBeInTheDocument());
    expect(screen.getByText("一")).toBeInTheDocument();
    // 整理之后选择被清空。
    expect(screen.queryByText(/已选/)).not.toBeInTheDocument();
  });

  it("Shift 点击选中一整段", async () => {
    const ipc = createMemoryIpc();
    for (const text of ["甲", "乙", "丙", "丁"]) await capture(ipc, text);
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("甲");

    // 列表从新到旧：丁、丙、乙、甲。
    fireEvent.click(screen.getByRole("checkbox", { name: "选择：丁" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择：乙" }), { shiftKey: true });
    expect(screen.getByText("已选 3 项")).toBeInTheDocument();
  });

  it("整理失败：条目回到列表，并提示错误", async () => {
    const ipc = createMemoryIpc();
    await capture(ipc, "整理周报");
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("整理周报");

    ipc.failNextOrganizeWith(new AppError("STORAGE_UNAVAILABLE", "boom"));
    fireEvent.click(within(row("整理周报")).getByRole("button", { name: "今天" }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.kind === "error")).toBe(true),
    );
    expect(await screen.findByText("整理周报")).toBeInTheDocument();
  });

  it("被引用的文件不在原处：显示「文件不存在」，不报错", async () => {
    const ipc = createMemoryIpc();
    await ipc.capture({
      input: { kind: "files", paths: ["C:\\资料\\报告 final.pdf"] },
      origin: "drop",
      sourceApplication: null,
    });
    const real = ipc.listInbox.bind(ipc);
    ipc.listInbox = async () =>
      (await real()).map((entry) => ({
        ...entry,
        attachments: entry.attachments.map((a) => ({ ...a, exists: false })),
      }));
    renderWithProviders(<InboxPage />, ipc);

    expect(await screen.findByText("文件不存在")).toBeInTheDocument();
    expect(screen.getByText("报告 final.pdf")).toBeInTheDocument();
  });

  it("点「粘贴」收进收集箱，并给出可撤销的提示", async () => {
    const ipc = createMemoryIpc();
    ipc.setClipboard({ text: "整理周报" });
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("收集箱是空的");

    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    expect(await screen.findByText("整理周报")).toBeInTheDocument();
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.message).toBe("已收集：整理周报");

    act(() => toast?.action?.onClick());
    await waitFor(() => expect(ipc.undoneCaptures).toHaveLength(1));
  });

  it("焦点不在输入框时按 Ctrl+V 粘贴；在输入框里按则是普通输入", async () => {
    const ipc = createMemoryIpc();
    ipc.setClipboard({ text: "来自剪贴板" });
    renderWithProviders(<InboxPage />, ipc);
    await screen.findByText("收集箱是空的");

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "v", ctrlKey: true });
    expect(ipc.calls).not.toContain("captureFromClipboard");
    input.remove();

    fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
    expect(await screen.findByText("来自剪贴板")).toBeInTheDocument();
    expect(ipc.calls.filter((call) => call === "captureFromClipboard")).toHaveLength(1);
  });

  it("剪贴板是空的：提示原因", async () => {
    renderWithProviders(<InboxPage />, createMemoryIpc());
    await screen.findByText("收集箱是空的");
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toContain(
        "剪贴板里没有可以收集的内容",
      ),
    );
  });
});
