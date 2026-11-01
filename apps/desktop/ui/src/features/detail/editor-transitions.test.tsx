import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainShell, useNavStore } from "@/features/shell";
import { AppError } from "@/lib/errors";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { AUTOSAVE_DELAY_MS } from "./use-item-draft";

/** 推进定时器并完成查询通知。 */
async function advance(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 编辑测试只使用内存数据。 */
async function seed(
  ipc: MemoryIpc,
  title: string,
  itemType: "todo" | "note" = "todo",
): Promise<string> {
  return (
    await ipc.createItem({
      itemType,
      title,
      content: null,
      contentFormat: "markdown",
      priority: null,
      scheduled: null,
      due: null,
      reminderAt: null,
      projectId: null,
    })
  ).id;
}

/** 模拟真实窗口的有效逻辑宽度。 */
function resize(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  fireEvent.resize(window);
}

describe("编辑器安全离开", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resize(1280);
    useNavStore.setState({
      view: "inbox",
      detailId: null,
      noteId: null,
      freshNoteId: null,
      leaveGuard: null,
      pendingNav: null,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    resize(1024);
    vi.restoreAllMocks();
  });

  it.each(["close", "sidebar", "item", "external-route"] as const)(
    "%s 保存失败保留草稿，重试成功才执行目的地",
    async (destination) => {
      const ipc = createMemoryIpc();
      const id = await seed(ipc, "第一项");
      const next = await seed(ipc, "第二项");
      useNavStore.setState({ detailId: id });
      renderWithProviders(<MainShell />, ipc);
      await advance();
      fireEvent.change(screen.getByLabelText("标题"), { target: { value: "保留的修改" } });
      ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
      if (destination === "close")
        fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
      if (destination === "sidebar") fireEvent.click(screen.getByRole("button", { name: "日历" }));
      if (destination === "item") act(() => ipc.emitMainViewRequested(`item:${next}`));
      if (destination === "external-route") act(() => ipc.emitMainViewRequested("calendar"));
      await advance();
      expect(screen.getByLabelText("标题")).toHaveValue("保留的修改");
      expect(useNavStore.getState().view).toBe("inbox");
      expect(useNavStore.getState().detailId).toBe(id);
      expect(screen.getByRole("alert")).toHaveTextContent("本地数据库暂时不可用");
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await advance();
      expect((await ipc.getItem(id)).title).toBe("保留的修改");
      expect(useNavStore.getState().detailId).toBe(destination === "item" ? next : null);
      expect(useNavStore.getState().view).toBe(
        destination === "sidebar" || destination === "external-route" ? "calendar" : "inbox",
      );
      expect(ipc.updates).toHaveLength(2);
    },
  );

  it("离开时等待在途保存及其后的修改；后续版本失败不会关闭或误报已保存", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "原稿");
    useNavStore.setState({ detailId: id });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = ipc.updateItem;
    const update = vi.spyOn(ipc, "updateItem").mockImplementationOnce(async (...args) => {
      await gate;
      return original(...args);
    });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "第一版" } });
    await advance(AUTOSAVE_DELAY_MS);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "最终版" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(useNavStore.getState().detailId).toBe(id);
    update.mockImplementationOnce(async () => {
      throw new AppError("STORAGE_UNAVAILABLE", "offline");
    });
    await act(async () => {
      release();
    });
    await advance();
    expect(screen.getByLabelText("标题")).toHaveValue("最终版");
    expect(screen.getByRole("alert")).toHaveTextContent("没能保存");
    expect(useNavStore.getState().detailId).toBe(id);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await advance();
    expect((await ipc.getItem(id)).title).toBe("最终版");
    expect(update).toHaveBeenCalledTimes(3);
    expect(useNavStore.getState().detailId).toBeNull();
  });

  it("连续目的地最新请求优先；选择留在这里清除旧目的地", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "原稿");
    useNavStore.setState({ detailId: id });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "未保存" } });
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    act(() => useNavStore.getState().setView("calendar"));
    await advance();
    act(() => useNavStore.getState().setView("projects"));
    fireEvent.click(screen.getByRole("button", { name: "留在这里" }));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await advance();
    expect(useNavStore.getState().view).toBe("inbox");
    expect(useNavStore.getState().detailId).toBe(id);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "再修改" } });
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    act(() => useNavStore.getState().setView("calendar"));
    await advance();
    act(() => useNavStore.getState().setView("projects"));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await advance();
    expect(useNavStore.getState().view).toBe("projects");
    expect((await ipc.getItem(id)).title).toBe("再修改");
  });

  it("放弃需要明确二次确认，返回确认仍保留草稿", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "原稿");
    useNavStore.setState({ detailId: id });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "未保存" } });
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改…" }));
    expect(useNavStore.getState().detailId).toBe(id);
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByLabelText("标题")).toHaveValue("未保存");
    fireEvent.click(screen.getByRole("button", { name: "放弃修改…" }));
    fireEvent.click(screen.getByRole("button", { name: "确认放弃" }));
    await advance();
    expect(useNavStore.getState().detailId).toBeNull();
    expect((await ipc.getItem(id)).title).toBe("原稿");
    expect(ipc.updates).toHaveLength(1);
  });

  it("Notes 切换失败保留正文；重试后只打开最新请求的笔记", async () => {
    const ipc = createMemoryIpc();
    const first = await seed(ipc, "第一篇", "note");
    const second = await seed(ipc, "第二篇", "note");
    const third = await seed(ipc, "第三篇", "note");
    useNavStore.setState({ view: "notes", noteId: first });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "长文修改" } });
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    fireEvent.click(screen.getByRole("button", { name: /第二篇/ }));
    await advance();
    expect(screen.getByLabelText("描述")).toHaveValue("长文修改");
    fireEvent.click(screen.getByRole("button", { name: /第三篇/ }));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await advance();
    expect(useNavStore.getState().noteId).toBe(third);
    expect((await ipc.getItem(first)).content).toBe("长文修改");
    expect(ipc.updates.every((entry) => entry.id !== second)).toBe(true);
  });

  it("停靠与模态间调整尺寸不替换输入节点、不丢选择或草稿", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "原稿");
    useNavStore.setState({ detailId: id });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    const title = screen.getByLabelText("标题") as HTMLInputElement;
    fireEvent.change(title, { target: { value: "正在编辑" } });
    title.focus();
    title.setSelectionRange(1, 3);
    resize(960);
    expect(screen.getByRole("dialog", { name: "条目详情" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("标题")).toBe(title);
    expect(title.selectionStart).toBe(1);
    expect(title.selectionEnd).toBe(3);
    expect(title).toHaveFocus();
    expect(document.querySelector("main")).toHaveAttribute("inert");
    resize(1280);
    expect(screen.getByRole("complementary", { name: "条目详情" })).not.toHaveAttribute(
      "aria-modal",
    );
    expect(screen.getByLabelText("标题")).toBe(title);
    expect(ipc.updates).toHaveLength(0);
    await advance(AUTOSAVE_DELAY_MS);
    expect(ipc.updates).toHaveLength(1);
  });

  it("侧页优先保存，随后保存背后的笔记，两个草稿不覆盖注册", async () => {
    const ipc = createMemoryIpc();
    const note = await seed(ipc, "笔记", "note");
    const detail = await seed(ipc, "待办");
    useNavStore.setState({ view: "notes", noteId: note, detailId: detail });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    fireEvent.change(within(screen.getByRole("article")).getByLabelText("描述"), {
      target: { value: "笔记修改" },
    });
    fireEvent.change(
      within(screen.getByRole("complementary", { name: "条目详情" })).getByLabelText("标题"),
      { target: { value: "侧页修改" } },
    );
    act(() => useNavStore.getState().setView("calendar"));
    await advance();
    expect(ipc.updates.map((entry) => entry.id)).toEqual([detail, note]);
    expect((await ipc.getItem(note)).content).toBe("笔记修改");
    expect((await ipc.getItem(detail)).title).toBe("侧页修改");
    expect(useNavStore.getState().view).toBe("calendar");
  });

  it("背后的笔记保存失败时，可从活动模态侧页重试并恢复导航", async () => {
    const ipc = createMemoryIpc();
    const note = await seed(ipc, "背后的笔记", "note");
    const detail = await seed(ipc, "待办");
    useNavStore.setState({ view: "notes", noteId: note, detailId: detail });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    fireEvent.change(within(screen.getByRole("article")).getByLabelText("描述"), {
      target: { value: "还没保存的正文" },
    });
    resize(960);
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    act(() => useNavStore.getState().setView("calendar"));
    await advance();
    const dialog = screen.getByRole("dialog", { name: "条目详情" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("背后的笔记");
    fireEvent.click(within(dialog).getByRole("button", { name: "放弃修改…" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("确认只放弃“背后的笔记”");
    fireEvent.click(within(dialog).getByRole("button", { name: "返回" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await advance();
    expect((await ipc.getItem(note)).content).toBe("还没保存的正文");
    expect(useNavStore.getState().view).toBe("calendar");
    expect(ipc.updates.every((entry) => entry.id === note)).toBe(true);
  });

  it("搜索打开条目前先保存 Notes；失败留住正文并在重试后打开正确条目", async () => {
    const ipc = createMemoryIpc();
    const note = await seed(ipc, "正在写的笔记", "note");
    const target = await seed(ipc, "搜索目标待办");
    useNavStore.setState({ view: "notes", noteId: note });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "待保存正文" } });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await advance();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "搜索目标待办" } });
    await advance(300);
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    fireEvent.keyDown(input, { key: "Enter" });
    await advance();
    expect(screen.getByLabelText("描述")).toHaveValue("待保存正文");
    expect(useNavStore.getState().detailId).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await advance();
    expect((await ipc.getItem(note)).content).toBe("待保存正文");
    expect(useNavStore.getState().detailId).toBe(target);
  });

  it("子菜单的 Escape 不关闭父编辑器；来源展开不写入条目", async () => {
    const ipc = createMemoryIpc();
    const capture = await ipc.capture({
      input: { kind: "text", text: "https://example.com/a/long/source" },
      origin: "drop",
      sourceApplication: "Chrome",
    });
    useNavStore.setState({ detailId: capture.items[0]?.id ?? null });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    const source = screen.getByRole("button", { name: "来源" });
    expect(source).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(source);
    expect(source).toHaveAttribute("aria-expanded", "true");
    expect(
      within(screen.getByRole("region", { name: "来源" })).getByText(
        "https://example.com/a/long/source",
      ),
    ).toBeVisible();
    expect(ipc.updates).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole("button", { name: "更多" }), { key: "ArrowDown" });
    await advance();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await advance();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "条目详情" })).toBeInTheDocument();
  });

  it("窄窗口导航抽屉包含 Tab，Escape 关闭后返回触发按钮", async () => {
    resize(600);
    renderWithProviders(<MainShell />, createMemoryIpc());
    await advance();
    const trigger = screen.getByRole("button", { name: "导航" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "导航" });
    expect(dialog).toHaveFocus();
    expect(document.querySelector("main")).toHaveAttribute("inert");
    fireEvent.keyDown(dialog, { key: "Tab" });
    const search = within(dialog).getByRole("button", { name: /搜索/ });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "导航" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.querySelector("main")).not.toHaveAttribute("inert");
    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "导航" })).getByRole("button", { name: "收集箱" }),
    );
    expect(screen.queryByRole("dialog", { name: "导航" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("详情保存后保留背后 Workflow 的离开检查，既有确认控件可达", async () => {
    resize(960);
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "待办");
    useNavStore.setState({ view: "workflows" });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    fireEvent.click(screen.getByRole("button", { name: /^网页链接/ }));
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await advance();
    fireEvent.change(screen.getByLabelText("创建"), { target: { value: "todo" } });
    act(() => useNavStore.getState().openItem(id));
    await advance();
    fireEvent.change(
      within(screen.getByRole("dialog", { name: "条目详情" })).getByLabelText("标题"),
      { target: { value: "已保存的待办修改" } },
    );
    act(() => useNavStore.getState().setView("today"));
    await advance();
    expect((await ipc.getItem(id)).title).toBe("已保存的待办修改");
    expect(useNavStore.getState().view).toBe("workflows");
    expect(useNavStore.getState().detailId).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("这条规则还有没保存的修改");
    expect(document.querySelector("main")).not.toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    await advance();
    expect(useNavStore.getState().view).toBe("today");
  });

  it("失败后重新选择当前 Notes 视图会取消过时目的地", async () => {
    const ipc = createMemoryIpc();
    const note = await seed(ipc, "笔记", "note");
    useNavStore.setState({ view: "notes", noteId: note });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "保留正文" } });
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    act(() => useNavStore.getState().setView("calendar"));
    await advance();
    act(() => useNavStore.getState().setView("notes"));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await advance();
    expect(useNavStore.getState().view).toBe("notes");
    expect((await ipc.getItem(note)).content).toBe("保留正文");
  });

  it("展开描述保留同一原生编辑器、选择与草稿，不在输入时自动折叠", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "待办");
    useNavStore.setState({ detailId: id });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    const body = screen.getByLabelText("描述") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "描述草稿" } });
    body.setSelectionRange(1, 3);
    fireEvent.click(screen.getByRole("button", { name: "展开描述" }));
    expect(screen.getByLabelText("描述")).toBe(body);
    expect(body.rows).toBe(12);
    expect(body).toHaveFocus();
    expect(body.selectionStart).toBe(1);
    expect(body.selectionEnd).toBe(3);
    fireEvent.change(body, { target: { value: "继续编辑描述" } });
    expect(body.rows).toBe(12);
    await advance(AUTOSAVE_DELAY_MS);
    expect((await ipc.getItem(id)).content).toBe("继续编辑描述");
  });

  it("默认尺寸从 Inbox 打开模态详情，关闭后回到真实的来源行", async () => {
    resize(960);
    const ipc = createMemoryIpc();
    await ipc.capture({
      input: { kind: "text", text: "可返回的 Inbox 条目" },
      origin: "paste",
      sourceApplication: null,
    });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    const row = screen.getByRole("button", { name: "可返回的 Inbox 条目" });
    row.focus();
    fireEvent.click(row);
    await advance();
    expect(screen.getByRole("dialog", { name: "条目详情" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    await advance();
    expect(row).toHaveFocus();
  });

  it("来源行已删除时，关闭详情将焦点交给仍存在的相邻行或页面标题", async () => {
    resize(960);
    const ipc = createMemoryIpc();
    await ipc.capture({
      input: { kind: "text", text: "保留的相邻条目" },
      origin: "paste",
      sourceApplication: null,
    });
    await ipc.capture({
      input: { kind: "text", text: "删除当前条目" },
      origin: "paste",
      sourceApplication: null,
    });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    const row = screen.getByRole("button", { name: "删除当前条目" });
    row.focus();
    fireEvent.click(row);
    await advance();
    fireEvent.keyDown(screen.getByRole("button", { name: "更多" }), { key: "ArrowDown" });
    await advance();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    await advance();
    expect(screen.queryByRole("dialog", { name: "条目详情" })).not.toBeInTheDocument();
    expect(row).not.toBeInTheDocument();
    expect([
      screen.getByRole("button", { name: "保留的相邻条目" }),
      screen.getByRole("heading", { name: "收集箱" }),
    ]).toContain(document.activeElement);
  });
});
