import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemDetailPanel } from "@/features/detail";
import { NotesPage } from "@/features/notes";
import { AppError } from "@/lib/errors";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { CONFIRM_WINDOW_MS, ConfirmButton } from "@/components/ConfirmButton";
import { TrashPage } from "./TrashPage";

/** 创建一个条目并返回 ID。 */
async function seed(
  ipc: MemoryIpc,
  itemType: "todo" | "note" | "tip",
  title: string,
): Promise<string> {
  const item = await ipc.createItem({
    itemType,
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

describe("回收站", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("空的时候说明保留规则", async () => {
    renderWithProviders(<TrashPage />, createMemoryIpc());
    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
    expect(screen.getByText(/保留 30 天/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /清空/ })).not.toBeInTheDocument();
  });

  it("列出被删除的条目，显示删除了多久、还剩几天；最近删除的在前", async () => {
    const ipc = createMemoryIpc();
    const a = await seed(ipc, "todo", "先删的");
    await ipc.deleteItems([a]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await seed(ipc, "note", "后删的");
    await ipc.deleteItems([b]);
    renderWithProviders(<TrashPage />, ipc);

    const list = await screen.findByRole("list", { name: "回收站里的条目" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("后删的");
    expect(rows[1]).toHaveTextContent("先删的");
    expect(rows[1]).toHaveTextContent("待办");
    expect(rows[1]).toHaveTextContent(/删除于.*前/);
    expect(rows[1]).toHaveTextContent("还剩 30 天自动清除");
    expect(screen.getByText("2 项")).toBeInTheDocument();
  });

  it("恢复：条目离开回收站并给出提示", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "todo", "要恢复的");
    await ipc.deleteItems([id]);
    renderWithProviders(<TrashPage />, ipc);

    fireEvent.click(await screen.findByRole("button", { name: "恢复「要恢复的」" }));
    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe("已恢复「要恢复的」");
    expect(
      (await ipc.listItems({ itemType: null, includeArchived: false, limit: null })).length,
    ).toBe(1);
  });

  it("恢复或彻底删除一项后，焦点落在下一项的同一个按钮上", async () => {
    const ipc = createMemoryIpc();
    for (const title of ["甲", "乙", "丙"]) {
      await ipc.deleteItems([await seed(ipc, "todo", title)]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    renderWithProviders(<TrashPage />, ipc);
    // 最近删除的在前：丙、乙、甲。
    const restore = await screen.findByRole("button", { name: "恢复「丙」" });
    restore.focus();
    fireEvent.click(restore);
    await waitFor(() => expect(screen.getByRole("button", { name: "恢复「乙」" })).toHaveFocus());

    const purge = screen.getByRole("button", { name: "永久删除「乙」" });
    purge.focus();
    fireEvent.click(purge);
    fireEvent.click(purge);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "永久删除「甲」" })).toHaveFocus(),
    );
  });

  it("↑ / ↓ 移到上一项 / 下一项的同一个按钮", async () => {
    const ipc = createMemoryIpc();
    for (const title of ["甲", "乙"]) {
      await ipc.deleteItems([await seed(ipc, "todo", title)]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    renderWithProviders(<TrashPage />, ipc);
    const purgeFirst = await screen.findByRole("button", { name: "永久删除「乙」" });
    purgeFirst.focus();
    fireEvent.keyDown(purgeFirst, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "永久删除「甲」" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "永久删除「甲」" }), { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "永久删除「甲」" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "永久删除「甲」" }), { key: "ArrowUp" });
    expect(purgeFirst).toHaveFocus();
  });

  it("项多时出现筛选框，按标题筛选；Esc 清空", async () => {
    const ipc = createMemoryIpc();
    for (let index = 0; index < 9; index += 1) {
      await ipc.deleteItems([await seed(ipc, "todo", `旧待办 ${index}`)]);
    }
    await ipc.deleteItems([await seed(ipc, "note", "要找回的周报")]);
    renderWithProviders(<TrashPage />, ipc);
    const filter = await screen.findByRole("searchbox", { name: "按标题筛选回收站" });

    fireEvent.change(filter, { target: { value: "周报" } });
    const list = screen.getByRole("list", { name: "回收站里的条目" });
    expect(within(list).getAllByRole("button", { name: /^恢复/ })).toHaveLength(1);
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "恢复「要找回的周报」" })).toHaveFocus();

    fireEvent.change(filter, { target: { value: "没有这个词" } });
    expect(screen.getByText("没有匹配的项。")).toBeInTheDocument();
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(within(list).getAllByRole("button", { name: /^恢复/ })).toHaveLength(10);
  });

  it("彻底删除需要再点一次确认；第一次点击什么都不会发生", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "note", "要彻底删除的");
    await ipc.deleteItems([id]);
    renderWithProviders(<TrashPage />, ipc);

    const button = await screen.findByRole("button", { name: "永久删除「要彻底删除的」" });
    fireEvent.click(button);
    expect(button).toHaveTextContent("再点一次确认");
    expect(ipc.calls).not.toContain("purgeItems");
    fireEvent.click(button);
    await waitFor(() => expect(ipc.calls).toContain("purgeItems"));
    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
    expect(ipc.items).toHaveLength(0);
  });

  it("清空回收站同样需要确认，并报告数量", async () => {
    const ipc = createMemoryIpc();
    const ids = [await seed(ipc, "todo", "a"), await seed(ipc, "todo", "b")];
    await ipc.deleteItems(ids);
    renderWithProviders(<TrashPage />, ipc);

    const button = await screen.findByRole("button", { name: "清空回收站" });
    fireEvent.click(button);
    expect(ipc.calls).not.toContain("emptyTrash");
    fireEvent.click(screen.getByRole("button", { name: "再点一次，永久清空" }));
    await waitFor(() => expect(ipc.calls).toContain("emptyTrash"));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe("已清空回收站（2 项）"),
    );
  });

  it("操作失败时提示原因，条目仍在回收站里", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "todo", "x");
    await ipc.deleteItems([id]);
    ipc.restoreDeletedItems = () => Promise.reject(new AppError("STORAGE_UNAVAILABLE", "boom"));
    renderWithProviders(<TrashPage />, ipc);

    fireEvent.click(await screen.findByRole("button", { name: "恢复「x」" }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.kind === "error")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "恢复「x」" })).toBeInTheDocument();
  });
});

describe("ConfirmButton", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("超时、失焦、Esc 都会取消确认状态", () => {
    const onConfirm = vi.fn();
    renderWithProviders(<ConfirmButton label="删除" confirmLabel="确认？" onConfirm={onConfirm} />);
    const button = screen.getByRole("button", { name: "删除" });

    fireEvent.click(button);
    expect(button).toHaveTextContent("确认？");
    act(() => {
      vi.advanceTimersByTime(CONFIRM_WINDOW_MS + 10);
    });
    expect(button).toHaveTextContent("删除");

    fireEvent.click(button);
    fireEvent.blur(button);
    expect(button).toHaveTextContent("删除");

    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(button).toHaveTextContent("删除");
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(button);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("从各处删除", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("详情面板的「删除」移进回收站、关闭面板，撤销后恢复", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "todo", "写周报");
    const onClose = vi.fn();
    renderWithProviders(<ItemDetailPanel id={id} onClose={onClose} />, ipc);
    await screen.findByLabelText("标题");

    fireEvent.keyDown(screen.getByRole("button", { name: "更多" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect((await ipc.listTrash())[0]?.item.id).toBe(id);
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.message).toBe("已删除「写周报」，可在回收站找回");

    act(() => toast?.action?.onClick());
    await waitFor(async () => expect(await ipc.listTrash()).toHaveLength(0));
  });

  it("笔记编辑区的「删除」：笔记离开列表", async () => {
    const ipc = createMemoryIpc();
    await seed(ipc, "note", "要删的笔记");
    renderWithProviders(<NotesPage />, ipc);
    await screen.findByLabelText("标题");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByText("还没有笔记")).toBeInTheDocument();
    expect(await ipc.listTrash()).toHaveLength(1);
  });

  it("删除失败：提示原因，什么都没变", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, "todo", "x");
    ipc.deleteItems = () => Promise.reject(new AppError("STORAGE_UNAVAILABLE", "boom"));
    const onClose = vi.fn();
    renderWithProviders(<ItemDetailPanel id={id} onClose={onClose} />, ipc);
    await screen.findByLabelText("标题");

    fireEvent.keyDown(screen.getByRole("button", { name: "更多" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.kind === "error")).toBe(true),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
