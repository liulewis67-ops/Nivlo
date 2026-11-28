import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EMPTY_TODAY, createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { FloatingApp } from "./FloatingApp";

describe("FloatingApp", () => {
  it("悬浮列表点击事项标题打开对应详情，勾选和排序手柄不会打开详情", async () => {
    const ipc = createMemoryIpc();
    ipc.setToday({
      ...EMPTY_TODAY,
      todos: [
        {
          id: "file-todo",
          itemType: "todo",
          title: "密钥.txt",
          brief: null,
          status: "open",
          priority: "none",
          scheduled: { date: EMPTY_TODAY.date, time: null },
          due: null,
          isOverdue: false,
        },
      ],
    });
    renderWithProviders(<FloatingApp />, ipc);
    fireEvent.pointerEnter(screen.getByRole("group", { name: "AsterJot悬浮窗" }));
    const title = await screen.findByRole("button", { name: "密钥.txt" });
    fireEvent.click(title);
    expect(ipc.openedItems).toEqual(["file-todo"]);
    fireEvent.click(screen.getByRole("button", { name: "拖动以调整「密钥.txt」的顺序" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /密钥.txt/ }));
    expect(ipc.openedItems).toEqual(["file-todo"]);
  });

  it("点击徽标请求打开主窗口", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingApp />, ipc);

    await user.click(screen.getByRole("button", { name: /打开AsterJot主窗口/ }));

    expect(ipc.openMainCalls).toBe(1);
  });
});
