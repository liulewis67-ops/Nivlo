import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MainShell, useNavStore } from "@/features/shell";
import { AppError } from "@/lib/errors";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { SearchApp } from "./SearchApp";

beforeEach(() => useNavStore.setState({ view: "today", detailId: null, leaveGuard: null }));

describe("搜索的可见操作与焦点", () => {
  it("点击即可输入；命令按钮与 > 等价；帮助先关闭，Tab 留在模态内，退出回到触发器", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MainShell />, createMemoryIpc());
    const opener = screen.getByRole("button", { name: /搜索/ });
    await user.click(opener);
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    await user.keyboard("inbox");
    expect(input).toHaveValue("inbox");
    await user.click(screen.getByRole("button", { name: "命令" }));
    expect(input).toHaveFocus();
    const buttonMode = screen.getAllByRole("option").map((entry) => entry.textContent);
    fireEvent.change(input, { target: { value: "> inbox" } });
    expect(screen.getAllByRole("option").map((entry) => entry.textContent)).toEqual(buttonMode);
    const help = screen.getByRole("button", { name: "键盘帮助" });
    await user.click(help);
    expect(screen.getByRole("region", { name: "键盘帮助" })).toHaveTextContent("Shift+Enter");
    await user.tab();
    expect(screen.getByRole("button", { name: "命令" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(help).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "键盘帮助" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "搜索" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("主窗口搜索在内容区打开详情并关闭搜索", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    const item = await ipc.quickCreate("todo", "需要打开的条目");
    renderWithProviders(<MainShell />, ipc);
    await user.click(screen.getByRole("button", { name: /搜索/ }));
    await screen.findByRole("option", { name: /需要打开的条目/ });
    await user.click(screen.getByRole("button", { name: "打开" }));
    expect(await screen.findByDisplayValue(item.title)).toBeInTheDocument();
    expect(ipc.openedItems).toEqual([]);
    expect(useNavStore.getState().detailId).toBe(item.id);
    expect(screen.getByLabelText("条目详情")).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "搜索" })).not.toBeInTheDocument();
  });

  it("旧结果等待替换期间不能用 Ctrl+D 完成错误的条目；失败保留查询并可重试", async () => {
    const ipc = createMemoryIpc();
    await ipc.quickCreate("todo", "原来的任务");
    const search = vi
      .spyOn(ipc, "searchItems")
      .mockRejectedValueOnce(new AppError("STORAGE_UNAVAILABLE", "injected"));
    renderWithProviders(<SearchApp />, ipc);
    const input = screen.getByRole("combobox");
    await screen.findByRole("option", { name: /原来的任务/ });
    fireEvent.change(input, { target: { value: "原来的" } });
    fireEvent.keyDown(input, { key: "d", ctrlKey: true });
    expect(ipc.items[0]?.status).toBe("open");
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    await screen.findByRole("listbox", { name: "搜索结果" });
    expect(input).toHaveValue("原来的");
    expect(search).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(ipc.items[0]?.status).toBe("done"));
    const undo = await screen.findByRole("button", { name: /撤销/ });
    expect(screen.queryByRole("button", { name: "创建待办" })).not.toBeInTheDocument();
    await userEvent.click(undo);
    await waitFor(() => expect(ipc.items[0]?.status).toBe("open"));
    expect(input).toHaveFocus();
  });

  it("全局窗口只提供受支持的前往命令；可见创建入口创建后隐藏窗口", async () => {
    const ipc = createMemoryIpc();
    await ipc.quickCreate("todo", "重复标题");
    renderWithProviders(<SearchApp />, ipc);
    await userEvent.click(screen.getByRole("button", { name: "命令" }));
    expect(screen.queryByRole("option", { name: /新建笔记/ })).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("option").every((entry) => entry.textContent?.includes("前往：")),
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "命令" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "重复标题" } });
    await screen.findByRole("listbox", { name: "搜索结果" });
    await userEvent.click(screen.getByRole("button", { name: "创建待办" }));
    await waitFor(() => expect(ipc.calls).toContain("hideSearch"));
    expect(ipc.items).toHaveLength(2);
    expect(within(screen.getByRole("listbox")).getAllByRole("option").length).toBeGreaterThan(0);
  });
});
