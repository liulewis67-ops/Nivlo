import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MainShell } from "./MainShell";
import { useNavStore } from "./nav-store";
import type { ItemTypeDto } from "@/lib/ipc";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";

/** 创建一个条目。 */
async function seed(
  ipc: MemoryIpc,
  itemType: ItemTypeDto,
  title: string,
  content: string | null = null,
): Promise<string> {
  const item = await ipc.createItem({
    itemType,
    title,
    content,
    contentFormat: "plain",
    priority: null,
    scheduled: null,
    due: null,
    reminderAt: null,
    projectId: null,
  });
  return item.id;
}

/** 在搜索框里输入，并等到防抖后的结果出现。 */
function typeQuery(text: string): void {
  fireEvent.change(screen.getByLabelText("搜索关键词"), { target: { value: text } });
}

/** 按 Ctrl+K。 */
function pressCtrlK(): void {
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
}

describe("全局搜索（Ctrl+K）", () => {
  beforeEach(() => {
    useNavStore.setState({ view: "today" });
  });

  it("Ctrl+K 打开，再按一次或 Esc 关闭；侧栏的搜索按钮也能打开", async () => {
    renderWithProviders(<MainShell />, createMemoryIpc());
    expect(screen.queryByRole("dialog", { name: "搜索" })).not.toBeInTheDocument();

    pressCtrlK();
    expect(await screen.findByRole("dialog", { name: "搜索" })).toBeInTheDocument();
    expect(screen.getByLabelText("搜索关键词")).toHaveFocus();
    expect(await screen.findByText("输入关键词，搜索标题、正文和来源。")).toBeInTheDocument();

    pressCtrlK();
    expect(screen.queryByRole("dialog", { name: "搜索" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /搜索/ }));
    const dialog = await screen.findByRole("dialog", { name: "搜索" });
    fireEvent.keyDown(within(dialog).getByLabelText("搜索关键词"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "搜索" })).not.toBeInTheDocument();
  });

  it("按类型分组显示结果，命中的文字高亮，并附带正文摘要；中文子串可搜", async () => {
    const ipc = createMemoryIpc();
    await seed(ipc, "todo", "修复登录超时");
    await seed(ipc, "note", "周报", "本周完成了登录页的改版，还有一些别的事情");
    await seed(ipc, "tip", "买牛奶");
    renderWithProviders(<MainShell />, ipc);
    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });

    typeQuery("登录");
    const list = await screen.findByRole("listbox", { name: "搜索结果" });
    const groups = within(list).getAllByRole("group");
    expect(groups.map((g) => within(g).getAllByRole("option").length)).toEqual([1, 1]);
    expect(within(list).getByText("待办")).toBeInTheDocument();
    expect(within(list).getByText("笔记")).toBeInTheDocument();
    // 命中的文字被 <mark> 包起来。
    expect(
      within(list)
        .getAllByText("登录", { selector: "mark" })
        .map((m) => m.tagName),
    ).toHaveLength(2);
    expect(within(list).getByText(/本周完成了/)).toBeInTheDocument();
    expect(screen.getByText("2 条结果")).toBeInTheDocument();
  });

  it("没有结果时给出提示；清空查询回到初始提示", async () => {
    renderWithProviders(<MainShell />, createMemoryIpc());
    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });

    typeQuery("不存在的词");
    expect(await screen.findByText("没有找到「不存在的词」")).toBeInTheDocument();
    typeQuery("");
    expect(await screen.findByText("输入关键词，搜索标题、正文和来源。")).toBeInTheDocument();
  });

  it("↑↓ 循环选择，回车打开选中项的详情并关闭面板", async () => {
    const ipc = createMemoryIpc();
    await seed(ipc, "todo", "登录一");
    const second = await seed(ipc, "note", "登录二");
    renderWithProviders(<MainShell />, ipc);
    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });
    typeQuery("登录");
    await screen.findByRole("listbox", { name: "搜索结果" });

    const input = screen.getByLabelText("搜索关键词");
    const options = () => screen.getAllByRole("option");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "搜索" })).not.toBeInTheDocument();
    expect(await screen.findByLabelText("条目详情")).toBeInTheDocument();
    await waitFor(() => expect(ipc.calls).toContain("getItemDetail"));
    expect(await screen.findByDisplayValue("登录二")).toBeInTheDocument();
    expect(ipc.items.find((i) => i.id === second)?.title).toBe("登录二");
  });

  it("没有结果时点「新建待办」：建好后直接打开它的详情", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<MainShell />, ipc);
    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });

    typeQuery("预约体检");
    fireEvent.click(await screen.findByRole("button", { name: /新建待办「预约体检」/ }));
    const detail = await screen.findByLabelText("条目详情");
    expect(await within(detail).findByDisplayValue("预约体检")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "搜索" })).not.toBeInTheDocument();
    expect(ipc.items.find((item) => item.title === "预约体检")?.itemType).toBe("todo");
  });

  it("点击结果打开详情；点击遮罩关闭", async () => {
    const ipc = createMemoryIpc();
    await seed(ipc, "note", "读书笔记");
    renderWithProviders(<MainShell />, ipc);
    pressCtrlK();
    const dialog = await screen.findByRole("dialog", { name: "搜索" });
    typeQuery("读书");
    fireEvent.click(await screen.findByRole("option", { name: /读书笔记/ }));
    expect(await screen.findByDisplayValue("读书笔记")).toBeInTheDocument();
    expect(dialog).not.toBeInTheDocument();

    pressCtrlK();
    const reopened = await screen.findByRole("dialog", { name: "搜索" });
    fireEvent.mouseDown(reopened.parentElement as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "搜索" })).not.toBeInTheDocument();
  });

  it("连续输入只在停顿之后搜索一次", async () => {
    const ipc = createMemoryIpc();
    await seed(ipc, "todo", "登录问题");
    renderWithProviders(<MainShell />, ipc);
    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });

    for (const text of ["登", "登录", "登录问"]) typeQuery(text);
    const results = await screen.findByRole("listbox", { name: "搜索结果" });
    expect(within(results).getByRole("option", { name: /登录问题/ })).toBeInTheDocument();
    expect(ipc.calls.filter((c) => c === "searchItems")).toHaveLength(1);
  });
});
