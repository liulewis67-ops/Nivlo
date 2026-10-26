import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { addDays, format } from "date-fns";
import { describe, expect, it } from "vitest";
import { SearchApp } from "./SearchApp";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";

/** 创建一条待办。 */
async function seedTodo(ipc: MemoryIpc, title: string): Promise<string> {
  const item = await ipc.createItem({
    itemType: "todo",
    title,
    content: null,
    contentFormat: "plain",
    priority: null,
    scheduled: null,
    due: null,
    reminderAt: null,
    projectId: null,
  });
  return item.id;
}

/** 搜索框。 */
function input(): HTMLElement {
  return screen.getByLabelText("搜索关键词");
}

describe("全局搜索窗口", () => {
  it("输入框自动聚焦；还没有任何条目时提示回车会在主窗口打开", async () => {
    renderWithProviders(<SearchApp />, createMemoryIpc());
    expect(input()).toHaveFocus();
    expect(await screen.findByText(/回车在主窗口中打开/)).toBeInTheDocument();
  });

  it("回车把选中的结果交给主窗口打开", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc, "修复登录超时");
    renderWithProviders(<SearchApp />, ipc);

    fireEvent.change(input(), { target: { value: "登录超时" } });
    const results = await screen.findByRole("listbox", { name: "搜索结果" });
    expect(within(results).getByRole("option", { name: /修复登录超时/ })).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(ipc.openedItems).toEqual([id]);
  });

  it("结果出来之前就按回车：等结果到了再打开第一条", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc, "季度复盘提纲");
    renderWithProviders(<SearchApp />, ipc);

    fireEvent.change(input(), { target: { value: "复盘提纲" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(ipc.openedItems).toEqual([]);
    await waitFor(() => expect(ipc.openedItems).toEqual([id]));
  });

  it("输入法组字时的回车不会打开结果", async () => {
    const ipc = createMemoryIpc();
    await seedTodo(ipc, "修复登录超时");
    renderWithProviders(<SearchApp />, ipc);

    fireEvent.change(input(), { target: { value: "登录超时" } });
    await screen.findByRole("listbox", { name: "搜索结果" });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(ipc.openedItems).toEqual([]);
  });

  it("空输入时列出最近更新的条目，↓ + 回车直接打开", async () => {
    const ipc = createMemoryIpc();
    await seedTodo(ipc, "较早的待办");
    const latest = await seedTodo(ipc, "刚刚改过的待办");
    renderWithProviders(<SearchApp />, ipc);

    const recent = await screen.findByRole("listbox", { name: "最近更新" });
    const options = within(recent).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("刚刚改过的待办"),
      expect.stringContaining("较早的待办"),
    ]);
    expect(screen.queryByText(/回车在主窗口中打开/)).not.toBeInTheDocument();

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(ipc.openedItems).toEqual([latest]);
  });

  it("开始输入后最近条目被搜索结果取代，清空输入又回到最近条目", async () => {
    const ipc = createMemoryIpc();
    await seedTodo(ipc, "修复登录超时");
    await seedTodo(ipc, "整理周报");
    renderWithProviders(<SearchApp />, ipc);
    await screen.findByRole("listbox", { name: "最近更新" });

    fireEvent.change(input(), { target: { value: "周报" } });
    const results = await screen.findByRole("listbox", { name: "搜索结果" });
    expect(within(results).getAllByRole("option")).toHaveLength(1);

    fireEvent.change(input(), { target: { value: "" } });
    const recent = screen.getByRole("listbox", { name: "最近更新" });
    expect(within(recent).getAllByRole("option")).toHaveLength(2);
  });

  it("找不到时 Ctrl+Enter 把搜索词记成待办（识别日期短语），随即隐藏窗口", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SearchApp />, ipc);

    fireEvent.change(input(), { target: { value: "买咖啡豆 明天" } });
    expect(await screen.findByText("没有找到「买咖啡豆 明天」")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建待办「买咖啡豆」/ })).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(ipc.searchHides).toBe(1));
    const created = ipc.items.find((item) => item.title === "买咖啡豆");
    expect(created?.itemType).toBe("todo");
    expect(created?.scheduled?.date).toBe(format(addDays(new Date(), 1), "yyyy-MM-dd"));
    expect(ipc.openedItems).toEqual([]);
  });

  it("有结果时 Ctrl+Enter 仍然新建，而不是打开选中的结果", async () => {
    const ipc = createMemoryIpc();
    await seedTodo(ipc, "周报模板");
    renderWithProviders(<SearchApp />, ipc);

    fireEvent.change(input(), { target: { value: "周报" } });
    await screen.findByRole("listbox", { name: "搜索结果" });
    expect(screen.getByText("Ctrl+↵ 新建待办")).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(ipc.items.map((item) => item.title)).toContain("周报"));
    expect(ipc.openedItems).toEqual([]);
  });

  it("空输入时 Ctrl+Enter 什么也不做", () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SearchApp />, ipc);
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    expect(ipc.items).toEqual([]);
    expect(ipc.searchHides).toBe(0);
  });

  it("搜索完成时通过 status 区域播报结果数量", async () => {
    const ipc = createMemoryIpc();
    await seedTodo(ipc, "周报模板");
    renderWithProviders(<SearchApp />, ipc);
    fireEvent.change(input(), { target: { value: "周报" } });
    await waitFor(() =>
      expect(screen.getAllByRole("status").map((node) => node.textContent)).toContain("1 条结果"),
    );
  });

  it("Esc 隐藏窗口", () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SearchApp />, ipc);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(ipc.searchHides).toBe(1);
  });

  it("每次被快捷键唤出都清空上一次的输入并重新聚焦", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SearchApp />, ipc);
    fireEvent.change(input(), { target: { value: "上一次" } });
    expect(input()).toHaveValue("上一次");

    act(() => ipc.emitSearchWindowShown());
    await waitFor(() => expect(input()).toHaveValue(""));
    expect(input()).toHaveFocus();
  });

  it("失去焦点（窗口随即被隐藏）时也先重置，下次出现不会闪出旧结果", async () => {
    renderWithProviders(<SearchApp />, createMemoryIpc());
    fireEvent.change(input(), { target: { value: "上一次" } });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(input()).toHaveValue(""));
  });
});
