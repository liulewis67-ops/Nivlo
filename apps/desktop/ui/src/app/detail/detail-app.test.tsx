import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipcModule from "@/lib/ipc";
import { AppError } from "@/lib/errors";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { useDraftTransitionStore } from "@/stores/draft-transition-store";
import { AUTOSAVE_DELAY_MS } from "@/features/detail";
import { DetailApp } from "./DetailApp";

const native = vi.hoisted(() => ({
  destroy: vi.fn(async () => undefined),
  setTitle: vi.fn(async () => undefined),
  stop: vi.fn(),
  stopResize: vi.fn(),
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  isMaximized: vi.fn(async () => false),
  resize: undefined as (() => void) | undefined,
  listener: undefined as ((event: { preventDefault: () => void }) => void) | undefined,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    destroy: native.destroy,
    setTitle: native.setTitle,
    minimize: native.minimize,
    toggleMaximize: native.toggleMaximize,
    isMaximized: native.isMaximized,
    onResized: async (callback: () => void) => {
      native.resize = callback;
      return native.stopResize;
    },
    onCloseRequested: async (callback: typeof native.listener) => {
      native.listener = callback;
      return native.stop;
    },
  }),
}));

/** 完成查询、保存与事件回调。 */
async function advance(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 挂载一个真实的独立详情根。 */
async function openDetail() {
  const ipc = createMemoryIpc();
  const item = await ipc.quickCreate("todo", "独立事项");
  const rendered = renderWithProviders(<DetailApp id={item.id} />, ipc);
  await advance();
  return { ipc, item, ...rendered };
}

describe("独立详情窗口", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    native.listener = undefined;
    native.resize = undefined;
    vi.spyOn(ipcModule, "isRunningInTauri").mockReturnValue(true);
  });
  afterEach(() => {
    useDraftTransitionStore.getState().cancel();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("占满窗口，原生标题显示事项名；卸载移除关闭监听", async () => {
    const { item, ipc, unmount } = await openDetail();
    expect(screen.getByLabelText("条目详情")).toHaveClass("nv-detail-window", "w-full");
    expect(screen.getByLabelText("条目详情")).not.toHaveClass("nv-detail-panel");
    expect(native.setTitle).toHaveBeenCalledWith("独立事项 · AsterJot");
    expect(ipc.calls).toContain("markItemOpened");
    expect(screen.getByLabelText("标题")).toHaveValue(item.title);
    unmount();
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(native.stopResize).toHaveBeenCalledTimes(1);
  });

  it("自绘标题栏区分拖动区与按钮，可最小化、最大化并同步还原状态", async () => {
    await openDetail();
    const title = screen.getByText("独立事项 · AsterJot");
    expect(title.closest("[data-tauri-drag-region]")).toHaveAttribute(
      "data-tauri-drag-region",
      "deep",
    );
    const minimize = screen.getByRole("button", { name: "最小化" });
    expect(minimize.closest("[data-tauri-drag-region]")).toBeNull();
    fireEvent.click(minimize);
    expect(native.minimize).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(native.toggleMaximize).toHaveBeenCalledOnce();
    native.isMaximized.mockResolvedValueOnce(true);
    act(() => native.resize?.());
    await advance(100);
    expect(screen.getByRole("button", { name: "还原窗口" })).toBeInTheDocument();
  });

  it.each(["native", "button", "titlebar", "escape"])(
    "%s 关闭会先保存修改再销毁窗口",
    async (mode) => {
      const { ipc, item } = await openDetail();
      fireEvent.change(screen.getByLabelText("标题"), { target: { value: "已修改" } });
      const preventDefault = vi.fn();
      if (mode === "native") act(() => native.listener?.({ preventDefault }));
      else if (mode === "titlebar")
        fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
      else if (mode === "button") fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
      else fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Escape" });
      await advance();
      if (mode === "native") expect(preventDefault).toHaveBeenCalledOnce();
      expect((await ipc.getItem(item.id)).title).toBe("已修改");
      expect(native.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each(["native", "titlebar"])(
    "%s 关闭保存失败保留窗口与草稿，重试成功后才销毁",
    async (mode) => {
      const { ipc, item } = await openDetail();
      fireEvent.change(screen.getByLabelText("标题"), { target: { value: "保留草稿" } });
      ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
      if (mode === "native") act(() => native.listener?.({ preventDefault: vi.fn() }));
      else fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
      await advance();
      expect(native.destroy).not.toHaveBeenCalled();
      expect(screen.getByLabelText("标题")).toHaveValue("保留草稿");
      expect(screen.getByRole("alert")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await advance();
      expect((await ipc.getItem(item.id)).title).toBe("保留草稿");
      expect(native.destroy).toHaveBeenCalledOnce();
    },
  );

  it("关闭等待在途保存及其后输入，保留同一输入节点和最终版本", async () => {
    const { ipc, item } = await openDetail();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = ipc.updateItem;
    vi.spyOn(ipc, "updateItem").mockImplementationOnce(async (...args) => {
      await gate;
      return original(...args);
    });
    const input = screen.getByLabelText("标题");
    fireEvent.change(input, { target: { value: "第一版" } });
    await advance(AUTOSAVE_DELAY_MS);
    fireEvent.change(input, { target: { value: "最终版" } });
    act(() => native.listener?.({ preventDefault: vi.fn() }));
    expect(native.destroy).not.toHaveBeenCalled();
    await act(async () => release());
    await advance();
    expect(screen.getByLabelText("标题")).toBe(input);
    expect((await ipc.getItem(item.id)).title).toBe("最终版");
    expect(native.destroy).toHaveBeenCalledOnce();
  });

  it("放弃草稿需二次确认，留在这里会取消关闭", async () => {
    const { ipc, item } = await openDetail();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "待确认" } });
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    act(() => native.listener?.({ preventDefault: vi.fn() }));
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "留在这里" }));
    expect(native.destroy).not.toHaveBeenCalled();
    ipc.failNextUpdateWith(new AppError("STORAGE_UNAVAILABLE", "offline"));
    act(() => native.listener?.({ preventDefault: vi.fn() }));
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改…" }));
    expect(native.destroy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认放弃" }));
    await advance();
    expect((await ipc.getItem(item.id)).title).toBe("独立事项");
    expect(native.destroy).toHaveBeenCalledOnce();
  });

  it("删除后保留窗口中的撤销入口，撤销后恢复详情", async () => {
    const { item, ipc } = await openDetail();
    fireEvent.keyDown(screen.getByRole("button", { name: "更多" }), { key: "ArrowDown" });
    await advance();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    await advance(60);
    expect(native.destroy).not.toHaveBeenCalled();
    expect((await ipc.listTrash()).map((entry) => entry.item.id)).toContain(item.id);
    const deleted = screen.getByRole("region", { name: "条目详情" });
    fireEvent.click(within(deleted).getByRole("button", { name: "撤销" }));
    await advance(60);
    expect(screen.getByLabelText("标题")).toHaveValue("独立事项");
    expect(await ipc.listTrash()).toHaveLength(0);
  });
});
