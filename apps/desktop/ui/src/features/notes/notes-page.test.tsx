import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTOSAVE_DELAY_MS } from "@/features/detail";
import { useNavStore } from "@/features/shell";
import { AppError } from "@/lib/errors";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { noteMatches } from "./model/note-filter";
import { noteSnippet } from "./model/note-snippet";
import { NotesPage } from "./NotesPage";

/** 创建一篇笔记；返回 ID。 */
async function seedNote(ipc: MemoryIpc, title: string, content: string | null): Promise<string> {
  const note = await ipc.createItem({
    itemType: "note",
    title,
    content,
    contentFormat: "markdown",
    priority: null,
    scheduled: null,
    due: null,
    reminderAt: null,
    projectId: null,
  });
  return note.id;
}

/** 等到自动保存发生。 */
function waitForSave(ipc: MemoryIpc, count: number) {
  return waitFor(() => expect(ipc.updates).toHaveLength(count), {
    timeout: AUTOSAVE_DELAY_MS + 2000,
  });
}

describe("noteSnippet", () => {
  it("去掉 Markdown 标记，取第一段有内容的文字", () => {
    expect(noteSnippet("\n\n## 会议纪要\n- 议题一")).toBe("会议纪要");
    expect(noteSnippet("> 引用的话")).toBe("引用的话");
    expect(noteSnippet(null)).toBe("");
    expect(noteSnippet("  \n ")).toBe("");
  });

  it("按字符截断，中文与 emoji 不会被切坏", () => {
    const long = "字".repeat(200);
    const snippet = noteSnippet(long);
    expect([...snippet]).toHaveLength(80);
    expect(snippet.endsWith("…")).toBe(true);
    expect(noteSnippet("😀".repeat(100)).startsWith("😀")).toBe(true);
  });
});

describe("noteMatches", () => {
  it("在标题或内容里找，不区分大小写，多个词都要出现", () => {
    const note = { title: "Weekly 周报", content: "本周完成了 Nivlo 的搜索" };
    expect(noteMatches(note, "")).toBe(true);
    expect(noteMatches(note, "  ")).toBe(true);
    expect(noteMatches(note, "weekly")).toBe(true);
    expect(noteMatches(note, "NIVLO 搜索")).toBe(true);
    expect(noteMatches(note, "周报 日历")).toBe(false);
    expect(noteMatches({ title: "空的", content: null }, "内容")).toBe(false);
  });
});

describe("NotesPage", () => {
  beforeEach(() => {
    useNavStore.setState({ noteId: null, freshNoteId: null });
  });

  it("没有笔记时给出空状态，点「新笔记」创建并立刻打开", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<NotesPage />, ipc);
    expect(await screen.findByText("还没有笔记")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "+ 新笔记" })[0] as HTMLElement);
    const title = await screen.findByLabelText("标题");
    expect(title).toHaveValue("未命名笔记");
    // 标题已聚焦并全选，直接打字就替换掉占位标题；Enter 跳到正文。
    expect(title).toHaveFocus();
    const input = title as HTMLInputElement;
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "未命名笔记".length]);
    fireEvent.keyDown(title, { key: "Enter" });
    expect(screen.getByLabelText("描述")).toHaveFocus();
    expect(ipc.items).toHaveLength(1);
    expect(ipc.items[0]).toMatchObject({ itemType: "note", contentFormat: "markdown" });
  });

  it("Ctrl+N 新建一篇并选中标题；在正文里按也行", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "已有的", "内容");
    renderWithProviders(<NotesPage />, ipc);
    const body = await screen.findByLabelText("描述");

    fireEvent.keyDown(body, { key: "n", ctrlKey: true });
    await waitFor(() => expect(ipc.items).toHaveLength(2));
    const title = await screen.findByDisplayValue("未命名笔记");
    await waitFor(() => expect(title).toHaveFocus());
  });

  it("按最近更新排序，默认打开最近更新的一篇，点击切换", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "旧的笔记", "第一版");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedNote(ipc, "新的笔记", "# 新的内容");
    renderWithProviders(<NotesPage />, ipc);

    const list = await screen.findByRole("list", { name: "笔记列表" });
    const titles = within(list)
      .getAllByRole("button")
      .map((button) => button.textContent ?? "");
    expect(titles[0]).toContain("新的笔记");
    expect(titles[0]).toContain("新的内容");
    expect(titles[1]).toContain("旧的笔记");
    expect(await screen.findByLabelText("标题")).toHaveValue("新的笔记");

    fireEvent.click(within(list).getByRole("button", { name: /旧的笔记/ }));
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveValue("旧的笔记"));
    expect(screen.getByLabelText("描述")).toHaveValue("第一版");
    // 打开已有的笔记不抢焦点。
    expect(screen.getByLabelText("标题")).not.toHaveFocus();
  });

  it("在列表里按 ↑ / ↓ 换到相邻的笔记，编辑区跟着切换，到头停住", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "旧的笔记", "第一版");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedNote(ipc, "新的笔记", "第二版");
    renderWithProviders(<NotesPage />, ipc);

    const list = await screen.findByRole("list", { name: "笔记列表" });
    const newer = within(list).getByRole("button", { name: /新的笔记/ });
    const older = within(list).getByRole("button", { name: /旧的笔记/ });
    newer.focus();
    fireEvent.keyDown(newer, { key: "ArrowDown" });
    expect(older).toHaveFocus();
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveValue("旧的笔记"));

    fireEvent.keyDown(older, { key: "ArrowDown" });
    expect(older).toHaveFocus();
    fireEvent.keyDown(older, { key: "ArrowUp" });
    expect(newer).toHaveFocus();
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveValue("新的笔记"));
  });

  it("筛选框按标题与内容筛选列表；↓ 打开第一篇，Esc 清空，没有匹配时说明", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "周报", "本周完成了搜索");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedNote(ipc, "读书笔记", "第一章");
    renderWithProviders(<NotesPage />, ipc);

    const filter = await screen.findByRole("searchbox", { name: "筛选笔记" });
    fireEvent.change(filter, { target: { value: "搜索" } });
    const list = screen.getByRole("list", { name: "笔记列表" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    // 筛选不切换正在编辑的笔记。
    expect(screen.getByLabelText("标题")).toHaveValue("读书笔记");

    fireEvent.keyDown(filter, { key: "ArrowDown" });
    const weekly = within(list).getByRole("button", { name: /周报/ });
    expect(weekly).toHaveFocus();
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveValue("周报"));

    fireEvent.change(filter, { target: { value: "没有这个词" } });
    expect(screen.getByText("没有匹配的笔记。")).toHaveAttribute("role", "status");
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(filter).toHaveValue("");
    expect(
      within(screen.getByRole("list", { name: "笔记列表" })).getAllByRole("button"),
    ).toHaveLength(2);
  });

  it("离开笔记页再回来，打开的还是上次那一篇", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "旧的笔记", "第一版");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedNote(ipc, "新的笔记", "第二版");
    const first = renderWithProviders(<NotesPage />, ipc);
    const list = await screen.findByRole("list", { name: "笔记列表" });
    fireEvent.click(within(list).getByRole("button", { name: /旧的笔记/ }));
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveValue("旧的笔记"));
    first.unmount();

    renderWithProviders(<NotesPage />, ipc);
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveValue("旧的笔记"));
  });

  it("编辑后自动保存，并立即在列表里按最新更新重排", async () => {
    const ipc = createMemoryIpc();
    const first = await seedNote(ipc, "先写的", "内容");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedNote(ipc, "后写的", "内容");
    renderWithProviders(<NotesPage />, ipc);

    const list = await screen.findByRole("list", { name: "笔记列表" });
    fireEvent.click(within(list).getByRole("button", { name: /先写的/ }));
    const body = await screen.findByLabelText("描述");
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveValue("先写的"));
    fireEvent.change(body, { target: { value: "改过的内容" } });
    await waitForSave(ipc, 1);

    expect(ipc.updates[0]).toMatchObject({
      id: first,
      request: { content: { value: "改过的内容" } },
    });
    await waitFor(() => {
      const buttons = within(screen.getByRole("list", { name: "笔记列表" })).getAllByRole("button");
      expect(buttons[0]?.textContent).toContain("先写的");
    });
  });

  it("上万字的笔记：输入与保存都只发生一次，字数实时统计", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "长文", "开头");
    renderWithProviders(<NotesPage />, ipc);
    const body = await screen.findByLabelText("描述");

    const text = "这是一段用来测试长文输入的文字。".repeat(700);
    expect([...text].length).toBeGreaterThan(10_000);
    const started = performance.now();
    fireEvent.change(body, { target: { value: text } });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(500);
    expect(screen.getByText(/1[0-9]{4} 字/)).toBeInTheDocument();

    await waitForSave(ipc, 1);
    expect(ipc.updates).toHaveLength(1);
    expect((await ipc.getItem(ipc.items[0]?.id ?? "")).content).toBe(text);
  });

  it("Markdown 笔记里 Ctrl+B 加粗选中的文字，再按一次取消；纯文本笔记不处理", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "笔记", "写 周报 了");
    renderWithProviders(<NotesPage />, ipc);
    const body = (await screen.findByLabelText("描述")) as HTMLTextAreaElement;

    body.setSelectionRange(2, 4);
    fireEvent.keyDown(body, { key: "b", ctrlKey: true });
    expect(body).toHaveValue("写 **周报** 了");
    body.setSelectionRange(4, 6);
    fireEvent.keyDown(body, { key: "b", ctrlKey: true });
    expect(body).toHaveValue("写 周报 了");
    body.setSelectionRange(2, 4);
    fireEvent.keyDown(body, { key: "i", ctrlKey: true });
    expect(body).toHaveValue("写 *周报* 了");

    fireEvent.click(screen.getByRole("button", { name: "纯文本" }));
    body.setSelectionRange(0, 1);
    fireEvent.keyDown(body, { key: "b", ctrlKey: true });
    expect(body).toHaveValue("写 *周报* 了");
  });

  it("Markdown 笔记的列表里按 Enter 续上记号，空的一项按 Enter 结束列表", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "清单", "- 买牛奶");
    renderWithProviders(<NotesPage />, ipc);
    const body = (await screen.findByLabelText("描述")) as HTMLTextAreaElement;

    body.setSelectionRange(5, 5);
    fireEvent.keyDown(body, { key: "Enter" });
    expect(body).toHaveValue("- 买牛奶\n- ");
    body.setSelectionRange(8, 8);
    fireEvent.keyDown(body, { key: "Enter" });
    expect(body).toHaveValue("- 买牛奶\n");
  });

  it("列表项上 Tab 缩进、Shift+Tab 取消；不在列表里时 Tab 不拦", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "清单", "说明\n- 子项");
    renderWithProviders(<NotesPage />, ipc);
    const body = (await screen.findByLabelText("描述")) as HTMLTextAreaElement;

    body.setSelectionRange(7, 7);
    expect(fireEvent.keyDown(body, { key: "Tab" })).toBe(false);
    expect(body).toHaveValue("说明\n  - 子项");
    fireEvent.keyDown(body, { key: "Tab", shiftKey: true });
    expect(body).toHaveValue("说明\n- 子项");

    body.setSelectionRange(1, 1);
    expect(fireEvent.keyDown(body, { key: "Tab" })).toBe(true);
    expect(body).toHaveValue("说明\n- 子项");
  });

  it("任务项上 Ctrl+Enter 勾选，再按一次取消", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "清单", "- [ ] 买牛奶");
    renderWithProviders(<NotesPage />, ipc);
    const body = (await screen.findByLabelText("描述")) as HTMLTextAreaElement;
    body.setSelectionRange(7, 7);
    fireEvent.keyDown(body, { key: "Enter", ctrlKey: true });
    expect(body).toHaveValue("- [x] 买牛奶");
    fireEvent.keyDown(body, { key: "Enter", ctrlKey: true });
    expect(body).toHaveValue("- [ ] 买牛奶");
  });

  it("切换格式会保存 content_format", async () => {
    const ipc = createMemoryIpc();
    await ipc.createItem({
      itemType: "note",
      title: "纯文本笔记",
      content: "x",
      contentFormat: "plain",
      priority: null,
      scheduled: null,
      due: null,
      reminderAt: null,
      projectId: null,
    });
    renderWithProviders(<NotesPage />, ipc);
    await screen.findByLabelText("描述");

    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    await waitForSave(ipc, 1);
    expect(ipc.updates[0]?.request).toEqual({ contentFormat: "markdown" });
  });

  it("归档：笔记离开列表，给出可撤销的提示，撤销后回来", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "要归档的", "内容");
    renderWithProviders(<NotesPage />, ipc);
    await screen.findByLabelText("标题");

    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    await waitFor(() => expect(ipc.organizations).toHaveLength(1));
    expect(ipc.organizations[0]?.action).toEqual({ kind: "archive" });
    expect(await screen.findByText("还没有笔记")).toBeInTheDocument();

    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.action).toBeDefined();
    act(() => toast?.action?.onClick());
    await waitFor(() => expect(ipc.restorations).toHaveLength(1));
  });

  it("归档后焦点落在列表里接下来的那一篇并打开它", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "留下的", "内容");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedNote(ipc, "要归档的", "内容");
    renderWithProviders(<NotesPage />, ipc);
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveValue("要归档的"));

    const archive = screen.getByRole("button", { name: "归档" });
    archive.focus();
    fireEvent.click(archive);
    await waitFor(() => expect(screen.getByRole("button", { name: /留下的/ })).toHaveFocus());
    expect(await screen.findByDisplayValue("留下的")).toHaveAccessibleName("标题");
  });

  it("保存失败：内容仍在文本框里，显示原因", async () => {
    const ipc = createMemoryIpc();
    await seedNote(ipc, "笔记", "内容");
    renderWithProviders(<NotesPage />, ipc);
    const body = await screen.findByLabelText("描述");

    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "boom"));
    fireEvent.change(body, { target: { value: "没保存成功的内容" } });
    expect(
      await screen.findByRole("alert", {}, { timeout: AUTOSAVE_DELAY_MS + 2000 }),
    ).toHaveTextContent("没能保存");
    expect(screen.getByLabelText("描述")).toHaveValue("没保存成功的内容");
  });
});
