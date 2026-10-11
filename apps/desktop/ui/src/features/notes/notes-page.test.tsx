import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AUTOSAVE_DELAY_MS } from "@/features/detail";
import { AppError } from "@/lib/errors";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
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

describe("NotesPage", () => {
  it("没有笔记时给出空状态，点「新笔记」创建并立刻打开", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<NotesPage />, ipc);
    expect(await screen.findByText("还没有笔记")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "+ 新笔记" })[0] as HTMLElement);
    const title = await screen.findByLabelText("标题");
    expect(title).toHaveValue("未命名笔记");
    expect(ipc.items).toHaveLength(1);
    expect(ipc.items[0]).toMatchObject({ itemType: "note", contentFormat: "markdown" });
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
