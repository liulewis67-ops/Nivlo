import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { AUTOSAVE_DELAY_MS, ItemDetailPanel } from "./ItemDetailPanel";

/** 推进虚拟时间并让挂起的 Promise 完成。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 创建一个待办并返回它的 ID。 */
async function seedTodo(ipc: MemoryIpc): Promise<string> {
  const item = await ipc.createItem({
    itemType: "todo",
    title: "写周报",
    content: "要点",
    contentFormat: "plain",
    priority: "high",
    scheduled: { date: "2026-10-12", time: null },
    due: null,
    reminderAt: null,
    projectId: null,
  });
  return item.id;
}

describe("ItemDetailPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("显示条目的各个字段；待办显示截止日期与优先级", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc);
    renderWithProviders(<ItemDetailPanel id={id} onClose={() => undefined} />, ipc);
    await advance(0);

    expect(screen.getByLabelText("标题")).toHaveValue("写周报");
    expect(screen.getByLabelText("描述")).toHaveValue("要点");
    expect(screen.getByLabelText("计划日期（日）")).toHaveValue("2026-10-12");
    expect(screen.getByLabelText("截止日期（日）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "高" })).toHaveAttribute("aria-pressed", "true");
  });

  it("停止输入后自动保存，并且只发送变化的字段；连续输入只保存一次", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc);
    renderWithProviders(<ItemDetailPanel id={id} onClose={() => undefined} />, ipc);
    await advance(0);

    const title = screen.getByLabelText("标题");
    fireEvent.change(title, { target: { value: "写周报（" } });
    await advance(AUTOSAVE_DELAY_MS - 100);
    fireEvent.change(title, { target: { value: "写周报（终稿）" } });
    await advance(AUTOSAVE_DELAY_MS - 100);
    expect(ipc.updates).toHaveLength(0);

    await advance(200);
    expect(ipc.updates).toEqual([{ id, request: { title: "写周报（终稿）" } }]);
    expect(screen.getByRole("status")).toHaveTextContent("已保存");
  });

  it("清空日期是「清除」；设置截止日期带时间", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc);
    renderWithProviders(<ItemDetailPanel id={id} onClose={() => undefined} />, ipc);
    await advance(0);

    fireEvent.change(screen.getByLabelText("计划日期（日）"), { target: { value: "" } });
    await advance(AUTOSAVE_DELAY_MS);
    expect(ipc.updates[0]?.request).toEqual({ scheduled: { kind: "clear" } });

    fireEvent.change(screen.getByLabelText("截止日期（日）"), { target: { value: "2026-10-20" } });
    fireEvent.change(screen.getByLabelText("截止时间"), { target: { value: "18:00" } });
    await advance(AUTOSAVE_DELAY_MS);
    expect(ipc.updates[1]?.request).toEqual({
      due: { kind: "set", value: { date: "2026-10-20", time: "18:00" } },
    });
  });

  it("转换类型：保存类型；转成笔记后不再显示截止日期与优先级", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc);
    renderWithProviders(<ItemDetailPanel id={id} onClose={() => undefined} />, ipc);
    await advance(0);

    fireEvent.click(screen.getByRole("button", { name: "笔记" }));
    expect(screen.queryByLabelText("截止日期（日）")).not.toBeInTheDocument();
    await advance(AUTOSAVE_DELAY_MS);
    expect(ipc.updates[0]?.request).toEqual({ itemType: "note" });
  });

  it("保存失败：修改仍然保留，显示原因与重试；重试成功后恢复", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc);
    renderWithProviders(<ItemDetailPanel id={id} onClose={() => undefined} />, ipc);
    await advance(0);

    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "boom"));
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "新的描述\n第二行" } });
    await advance(AUTOSAVE_DELAY_MS);

    expect(screen.getByRole("alert")).toHaveTextContent("没能保存：本地数据库暂时不可用。");
    // 编辑内容没有丢。
    expect(screen.getByLabelText("描述")).toHaveValue("新的描述\n第二行");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await advance(0);
    expect(ipc.updates).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("描述")).toHaveValue("新的描述\n第二行");
    expect((await ipc.getItem(id)).content).toBe("新的描述\n第二行");
  });

  it("违反领域规则（空标题）：显示后端的原因，不丢内容", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc);
    renderWithProviders(<ItemDetailPanel id={id} onClose={() => undefined} />, ipc);
    await advance(0);

    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "  " } });
    await advance(AUTOSAVE_DELAY_MS);
    expect(screen.getByRole("alert")).toHaveTextContent("标题不能为空");
    expect(screen.getByLabelText("标题")).toHaveValue("  ");
  });

  it("关闭时先保存还没保存的修改", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc);
    let closed = false;
    const { unmount } = renderWithProviders(
      <ItemDetailPanel
        id={id}
        onClose={() => {
          closed = true;
        }}
      />,
      ipc,
    );
    await advance(0);

    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "关闭前的修改" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(closed).toBe(true);
    unmount();
    await advance(0);
    expect(ipc.updates).toEqual([{ id, request: { title: "关闭前的修改" } }]);
  });

  it("Esc 关闭", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc);
    let closed = 0;
    renderWithProviders(
      <ItemDetailPanel
        id={id}
        onClose={() => {
          closed += 1;
        }}
      />,
      ipc,
    );
    await advance(0);
    fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Escape" });
    expect(closed).toBe(1);
  });

  it("来源：网址显示链接并可以打开；文件不存在时禁用并提示", async () => {
    const ipc = createMemoryIpc();
    const captured = await ipc.capture({
      input: { kind: "text", text: "https://example.com/a" },
      origin: "drop",
      sourceApplication: "Chrome",
    });
    const id = captured.items[0]?.id ?? "";
    renderWithProviders(<ItemDetailPanel id={id} onClose={() => undefined} />, ipc);
    await advance(0);

    expect(screen.getByText("https://example.com/a")).toBeInTheDocument();
    expect(screen.getByText(/网页链接/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在浏览器中打开" }));
    await advance(0);
    expect(ipc.openedSources).toEqual([id]);
  });

  it("打开来源失败（文件已不在）：提示原因", async () => {
    const ipc = createMemoryIpc();
    const captured = await ipc.capture({
      input: { kind: "files", paths: ["C:\\资料\\报告.pdf"] },
      origin: "paste",
      sourceApplication: null,
    });
    const id = captured.items[0]?.id ?? "";
    renderWithProviders(<ItemDetailPanel id={id} onClose={() => undefined} />, ipc);
    await advance(0);

    ipc.failNextOpenSourceWith(new AppError("SOURCE_FILE_MISSING", "gone"));
    fireEvent.click(screen.getByRole("button", { name: "在文件夹中显示" }));
    await advance(0);
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain("文件已经不在原来的位置");
  });

  it("手动创建的条目没有来源区块", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc);
    renderWithProviders(<ItemDetailPanel id={id} onClose={() => undefined} />, ipc);
    await advance(0);
    expect(screen.queryByRole("region", { name: "来源" })).not.toBeInTheDocument();
  });
});
