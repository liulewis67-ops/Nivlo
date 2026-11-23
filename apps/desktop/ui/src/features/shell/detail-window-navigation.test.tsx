import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { MainShell } from "./MainShell";
import { useNavStore } from "./nav-store";

describe("主窗口内容区详情", () => {
  beforeEach(() => useNavStore.setState({ view: "today", detailId: null, leaveGuard: null }));

  it("在主内容区查看详情，关闭回到列表，侧栏导航仍然可用", async () => {
    const ipc = createMemoryIpc();
    const item = await ipc.quickCreate("todo", "查看独立详情");
    renderWithProviders(<MainShell />, ipc);
    const title = await screen.findByRole("button", { name: "查看独立详情" });
    fireEvent.click(title);
    const detail = await screen.findByLabelText("条目详情");
    expect(detail).toHaveClass("w-full");
    expect(detail).not.toHaveClass("fixed", "nv-detail-panel");
    expect(await screen.findByDisplayValue(item.title)).toBeInTheDocument();
    expect(ipc.openedItems).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    await waitFor(() => expect(screen.queryByLabelText("条目详情")).not.toBeInTheDocument());
    expect(title).toBeVisible();
    fireEvent.click(title);
    await screen.findByLabelText("条目详情");
    const calendar = screen.getByRole("button", { name: "日历" });
    expect(calendar.closest("[inert]")).toBeNull();
    fireEvent.click(calendar);
    await waitFor(() => expect(calendar).toHaveAttribute("aria-current", "page"));
    expect(ipc.openedItems).toEqual([]);
  });
});
