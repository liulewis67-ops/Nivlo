import { act, fireEvent, screen, waitFor } from "@testing-library/react";
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
  it("输入框自动聚焦，空输入时提示回车会在主窗口打开", () => {
    renderWithProviders(<SearchApp />, createMemoryIpc());
    expect(input()).toHaveFocus();
    expect(screen.getByText(/回车在主窗口中打开/)).toBeInTheDocument();
  });

  it("回车把选中的结果交给主窗口打开", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc, "修复登录超时");
    renderWithProviders(<SearchApp />, ipc);

    fireEvent.change(input(), { target: { value: "登录超时" } });
    expect(await screen.findByRole("option", { name: /修复登录超时/ })).toBeInTheDocument();
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
    await screen.findByRole("option", { name: /修复登录超时/ });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(ipc.openedItems).toEqual([]);
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
