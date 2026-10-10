import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { useToastStore } from "@/stores/toast-store";
import { QuickCreateForm } from "./QuickCreateForm";

/** 渲染一个 Todo 的快速创建输入行，并等待它拿到键盘焦点。 */
async function renderReady(ipc = createMemoryIpc(), onDone = vi.fn()) {
  const { unmount } = renderWithProviders(<QuickCreateForm kind="todo" onDone={onDone} />, ipc);
  const input = screen.getByRole("textbox", { name: "标题" });
  await waitFor(() => expect(input).toHaveFocus());
  return { ipc, onDone, input, unmount };
}

describe("QuickCreateForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    useToastStore.setState({ toasts: [] });
  });

  it("挂载时先向后端申请键盘焦点，拿到之后才启用并聚焦输入框", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<QuickCreateForm kind="todo" onDone={vi.fn()} />, ipc);
    const input = screen.getByRole("textbox", { name: "标题" });
    expect(ipc.calls).toEqual(["beginFloatingInput"]);

    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveFocus();
  });

  it("输入标题后 Enter 创建，只提交类型与标题，并随后结束", async () => {
    const user = userEvent.setup();
    const { ipc, onDone } = await renderReady();

    await user.keyboard("  写周报 {Enter}");

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(ipc.items).toHaveLength(1);
    expect(ipc.items[0]?.title).toBe("写周报");
    expect(ipc.items[0]?.itemType).toBe("todo");
    // 默认日期由后端（这里是 Mock）决定，前端没有传日期。
    expect(ipc.items[0]?.scheduled).toEqual({ date: "2026-10-10", time: null });
  });

  it("空标题与纯空白按 Enter 不会提交", async () => {
    const user = userEvent.setup();
    const { ipc, onDone } = await renderReady();

    await user.keyboard("{Enter}");
    await user.keyboard("   {Enter}");

    expect(ipc.calls).not.toContain("quickCreate");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("Esc 取消，不创建任何数据", async () => {
    const user = userEvent.setup();
    const { ipc, onDone } = await renderReady();

    await user.keyboard("写到一半{Escape}");

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(ipc.calls).not.toContain("quickCreate");
    expect(ipc.items).toHaveLength(0);
  });

  it("输入法组合期间的 Enter 不会提交（拼音上屏）", async () => {
    const { ipc, input } = await renderReady();
    fireEvent.change(input, { target: { value: "xiezhoubao" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(ipc.calls).not.toContain("quickCreate");
  });

  it("创建失败时保留输入、弹出错误提示且不结束，可以修改后重试", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    ipc.failNextQuickCreateWith(new AppError("STORAGE_UNAVAILABLE", "db busy"));
    const { onDone, input } = await renderReady(ipc);

    await user.keyboard("写周报{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("本地数据库暂时不可用。");
    expect(onDone).not.toHaveBeenCalled();
    expect(input).toHaveValue("写周报");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(ipc.items).toHaveLength(1);
  });

  it("无法获得键盘焦点时提示错误并结束，而不是卡在一个不可用的输入行", async () => {
    const ipc = createMemoryIpc();
    ipc.failNextBeginInputWith(new AppError("WINDOW_UNAVAILABLE", "cannot focus"));
    const onDone = vi.fn();
    renderWithProviders(<QuickCreateForm kind="note" onDone={onDone} />, ipc);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert")).toHaveTextContent("无法打开窗口");
  });

  it("窗口失去系统焦点（用户点了别处）视为取消", async () => {
    const { onDone } = await renderReady();

    fireEvent.blur(window);

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("卸载时归还键盘焦点：endFloatingInput 恰好调用一次", async () => {
    const { ipc, unmount } = await renderReady();
    expect(ipc.calls).not.toContain("endFloatingInput");

    unmount();

    expect(ipc.calls.filter((call) => call === "endFloatingInput")).toHaveLength(1);
  });

  it("窗口始终没有拿到系统焦点时自动结束，避免用户被困在不响应的输入行里", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const ipc = createMemoryIpc();
    const onDone = vi.fn();
    renderWithProviders(<QuickCreateForm kind="todo" onDone={onDone} />, ipc);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
