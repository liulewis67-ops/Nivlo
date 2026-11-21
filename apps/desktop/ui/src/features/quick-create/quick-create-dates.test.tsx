import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { QuickCreateForm } from "./QuickCreateForm";

/** 渲染（今天 = 2026-10-14 周三）并等到输入框拿到焦点。 */
async function renderReady(kind: "todo" | "note" | "tip" = "todo") {
  const ipc = createMemoryIpc();
  const onDone = vi.fn();
  renderWithProviders(<QuickCreateForm kind={kind} today="2026-10-14" onDone={onDone} />, ipc);
  const input = screen.getByRole("textbox", { name: "标题" });
  await waitFor(() => expect(input).toHaveFocus());
  return { ipc, onDone, input };
}

describe("快速创建里的日期识别", () => {
  it("输入时实时显示识别结果；提交时标题去掉了短语、计划带上日期与时间", async () => {
    const user = userEvent.setup();
    const { ipc, onDone } = await renderReady();

    await user.keyboard("明天下午3点 Review PR");
    expect(screen.getByRole("status")).toHaveTextContent("识别到计划：明天 · 10月15日 周四 15:00");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(ipc.items[0]?.title).toBe("Review PR");
    expect(ipc.items[0]?.scheduled).toEqual({ date: "2026-10-15", time: "15:00" });
  });

  it("没有日期短语时没有提示，也不传计划（由后端用默认规则）", async () => {
    const user = userEvent.setup();
    const { ipc, onDone } = await renderReady();

    await user.keyboard("写周报");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(ipc.items[0]?.title).toBe("写周报");
    expect(ipc.items[0]?.scheduled).toEqual({ date: "2026-10-10", time: null });
  });

  it("点 ✕ 取消识别：标题保持原样，计划走默认规则；再改短语会重新识别", async () => {
    const user = userEvent.setup();
    const { ipc, onDone, input } = await renderReady();

    await user.keyboard("周五 开会");
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "取消日期识别" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(input).toHaveValue("周五 开会");

    // 把短语改成别的，重新被识别。
    fireEvent.change(input, { target: { value: "周六 开会" } });
    expect(screen.getByRole("status")).toHaveTextContent("10月17日 周六");

    fireEvent.mouseDown(screen.getByRole("button", { name: "取消日期识别" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(ipc.items[0]?.title).toBe("周六 开会");
    expect(ipc.items[0]?.scheduled).toEqual({ date: "2026-10-10", time: null });
  });

  it("短语在末尾时，第一下退格只取消识别、不删字符；第二下才删字符", async () => {
    const user = userEvent.setup();
    const { input } = await renderReady();

    await user.keyboard("Review PR 明天");
    expect(screen.getByRole("status")).toBeInTheDocument();

    await user.keyboard("{Backspace}");
    expect(input).toHaveValue("Review PR 明天");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await user.keyboard("{Backspace}");
    expect(input).toHaveValue("Review PR 明");
  });

  it("短语不在末尾时，退格照常删字符", async () => {
    const user = userEvent.setup();
    const { input } = await renderReady();

    await user.keyboard("明天 Review PR");
    await user.keyboard("{Backspace}");
    expect(input).toHaveValue("明天 Review P");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("歧义输入保持普通文本：整句只有「明天」、没有时段的 3 点", async () => {
    const user = userEvent.setup();
    const { ipc, onDone } = await renderReady();

    await user.keyboard("3点开会");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(ipc.items[0]?.title).toBe("3点开会");
  });

  it("笔记也可以带计划日期", async () => {
    const user = userEvent.setup();
    const { ipc, onDone } = await renderReady("note");

    await user.keyboard("下周一 整理读书笔记{Enter}");
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(ipc.items[0]?.itemType).toBe("note");
    expect(ipc.items[0]?.scheduled).toEqual({ date: "2026-10-19", time: null });
  });
});
