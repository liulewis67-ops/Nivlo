import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainShell, useNavStore } from "@/features/shell";
import { AppError } from "@/lib/errors";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { bodySelection, bodyText, selectBody, setBody } from "@/test/markdown-body";
import { renderWithProviders } from "@/test/render";
import { AUTOSAVE_DELAY_MS } from "./use-item-draft";
import { ItemDetailPanel } from "./ItemDetailPanel";

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

  it("Notes 切换失败保留正文；重试后只打开最新请求的笔记", async () => {
    const ipc = createMemoryIpc();
    const first = await seed(ipc, "第一篇", "note");
    const second = await seed(ipc, "第二篇", "note");
    const third = await seed(ipc, "第三篇", "note");
    useNavStore.setState({ view: "notes", noteId: first });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    act(() => setBody(screen.getByLabelText("描述"), "长文修改"));
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    fireEvent.click(screen.getByRole("button", { name: /第二篇/ }));
    await advance();
    expect(bodyText(screen.getByLabelText("描述"))).toBe("长文修改");
    fireEvent.click(screen.getByRole("button", { name: /第三篇/ }));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await advance();
    expect(useNavStore.getState().noteId).toBe(third);
    expect((await ipc.getItem(first)).content).toBe("长文修改");
    expect(ipc.updates.every((entry) => entry.id !== second)).toBe(true);
  });

  it("搜索打开条目前先保存 Notes；失败留住正文并在重试后打开正确条目", async () => {
    const ipc = createMemoryIpc();
    const note = await seed(ipc, "正在写的笔记", "note");
    const target = await seed(ipc, "搜索目标待办");
    useNavStore.setState({ view: "notes", noteId: note });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    act(() => setBody(screen.getByLabelText("描述"), "待保存正文"));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await advance();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "搜索目标待办" } });
    await advance(300);
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    fireEvent.keyDown(input, { key: "Enter" });
    await advance();
    expect(bodyText(screen.getByLabelText("描述"))).toBe("待保存正文");
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
    renderWithProviders(
      <ItemDetailPanel id={capture.items[0]?.id ?? ""} standalone onClose={() => undefined} />,
      ipc,
    );
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

  it("失败后重新选择当前 Notes 视图会取消过时目的地", async () => {
    const ipc = createMemoryIpc();
    const note = await seed(ipc, "笔记", "note");
    useNavStore.setState({ view: "notes", noteId: note });
    renderWithProviders(<MainShell />, ipc);
    await advance();
    act(() => setBody(screen.getByLabelText("描述"), "保留正文"));
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
    renderWithProviders(<ItemDetailPanel id={id} standalone onClose={() => undefined} />, ipc);
    await advance();
    const body = screen.getByLabelText("描述");
    // 描述是 Markdown：外框的高度按行数算（3 行，展开后 12 行）。
    const rows = () => body.closest(".cm-editor")?.parentElement?.dataset.rows;
    expect(rows()).toBe("3");
    act(() => setBody(body, "描述草稿"));
    selectBody(body, 1, 3);
    fireEvent.click(screen.getByRole("button", { name: "展开描述" }));
    expect(screen.getByLabelText("描述")).toBe(body);
    expect(rows()).toBe("12");
    expect(body).toHaveFocus();
    expect(bodySelection(body)).toEqual([1, 3]);
    act(() => setBody(body, "继续编辑描述"));
    expect(rows()).toBe("12");
    await advance(AUTOSAVE_DELAY_MS);
    expect((await ipc.getItem(id)).content).toBe("继续编辑描述");
  });
});
