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
    expect(await screen.findByText(/输入关键词，搜索标题、正文和来源/)).toBeInTheDocument();

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
    expect(await screen.findByText(/输入关键词，搜索标题、正文和来源/)).toBeInTheDocument();
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

  it("输入 > 列出命令，按名称过滤，回车前往对应视图并关闭面板；不会搜索条目", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<MainShell />, ipc);
    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });
    expect(await screen.findByText("输入 > 使用命令")).toBeInTheDocument();

    typeQuery(">");
    const commands = screen.getByRole("listbox", { name: "命令" });
    expect(within(commands).getByRole("option", { name: /前往：收集箱/ })).toBeInTheDocument();

    typeQuery("> 设置");
    expect(within(commands).getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(screen.getByLabelText("搜索关键词"), { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "搜索" })).not.toBeInTheDocument();
    expect(useNavStore.getState().view).toBe("settings");
    expect(ipc.calls).not.toContain("searchItems");
  });

  it("「新建笔记」命令建好一篇未命名笔记并直接打开它的详情", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<MainShell />, ipc);
    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });

    typeQuery("> 新建笔记");
    fireEvent.keyDown(screen.getByLabelText("搜索关键词"), { key: "Enter" });

    const detail = await screen.findByLabelText("条目详情");
    expect(await within(detail).findByDisplayValue("未命名笔记")).toBeInTheDocument();
    expect(ipc.items.map((item) => [item.itemType, item.title])).toEqual([["note", "未命名笔记"]]);
  });

  it("「暂停通知」与设置页是同一个开关；暂停后命令变成「恢复通知」", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<MainShell />, ipc);
    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });

    typeQuery(">pause");
    fireEvent.click(await screen.findByRole("option", { name: /暂停通知/ }));
    await waitFor(() => expect(ipc.appSettings.notificationsPaused).toBe(true));
    expect(await screen.findByText(/已暂停通知/)).toBeInTheDocument();

    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });
    typeQuery(">pause");
    expect(screen.getByRole("option", { name: /恢复通知/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /暂停通知/ })).not.toBeInTheDocument();
  });

  it("命令也能用英文视图名匹配；没有匹配时给出提示", async () => {
    renderWithProviders(<MainShell />, createMemoryIpc());
    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });

    typeQuery(">trash");
    expect(screen.getByRole("option", { name: /前往：回收站/ })).toBeInTheDocument();
    typeQuery(">不存在");
    expect(screen.getByText("没有匹配的命令")).toBeInTheDocument();
  });

  it("打开过的条目排到「最近使用」的最前面", async () => {
    const ipc = createMemoryIpc();
    await seed(ipc, "note", "很久以前的笔记");
    await seed(ipc, "todo", "刚建的待办");
    renderWithProviders(<MainShell />, ipc);

    pressCtrlK();
    typeQuery("很久以前");
    fireEvent.click(await screen.findByRole("option", { name: /很久以前的笔记/ }));
    await waitFor(() => expect(ipc.calls).toContain("markItemOpened"));

    pressCtrlK();
    const recent = await screen.findByRole("listbox", { name: "最近使用" });
    await waitFor(() =>
      expect(within(recent).getAllByRole("option")[0]).toHaveTextContent("很久以前的笔记"),
    );
  });

  it("结果旁显示条目的标签", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "todo", "整理发票");
    await ipc.setItemTags(id, ["报销", "财务"]);
    renderWithProviders(<MainShell />, ipc);
    pressCtrlK();
    typeQuery("发票");
    const results = await screen.findByRole("listbox", { name: "搜索结果" });
    expect(await within(results).findByText(/#报销 #财务/)).toBeInTheDocument();
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

describe("键盘快捷键一览", () => {
  beforeEach(() => {
    useNavStore.setState({ view: "today" });
  });

  it("按 ? 打开，列出各处的快捷键与真实的全局绑定；Esc 关闭", async () => {
    renderWithProviders(<MainShell />, createMemoryIpc());
    await screen.findByRole("textbox", { name: "添加待办" });

    fireEvent.keyDown(document.body, { key: "?" });
    const sheet = await screen.findByRole("dialog", { name: "键盘快捷键" });
    expect(within(sheet).getByText("完成选中的待办")).toBeInTheDocument();
    expect(within(sheet).getByText("Ctrl+D")).toBeInTheDocument();
    expect(await within(sheet).findByText("Ctrl+Shift+Space")).toBeInTheDocument();
    expect(within(sheet).getByText("Ctrl+Alt+Space")).toBeInTheDocument();

    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "键盘快捷键" })).not.toBeInTheDocument();
  });

  it("在输入框里打 ? 只是一个问号，不会打开", async () => {
    renderWithProviders(<MainShell />, createMemoryIpc());
    const input = await screen.findByRole("textbox", { name: "添加待办" });
    fireEvent.keyDown(input, { key: "?" });
    expect(screen.queryByRole("dialog", { name: "键盘快捷键" })).not.toBeInTheDocument();
  });

  it("Ctrl+K 的命令也能打开", async () => {
    renderWithProviders(<MainShell />, createMemoryIpc());
    pressCtrlK();
    await screen.findByRole("dialog", { name: "搜索" });
    typeQuery("> 快捷键");
    fireEvent.keyDown(screen.getByLabelText("搜索关键词"), { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "键盘快捷键" })).toBeInTheDocument();
  });
});
