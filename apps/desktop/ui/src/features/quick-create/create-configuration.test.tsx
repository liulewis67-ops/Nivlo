import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ItemTypeDto } from "@/lib/ipc";
import { AppError } from "@/lib/errors";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { CreateConfiguration } from "./CreateConfiguration";

/** 准备一个已拿到原生焦点的配置页。 */
async function ready(ipc = createMemoryIpc()) {
  const onDone = vi.fn();
  const begin = vi.spyOn(ipc, "beginFloatingInput");
  renderWithProviders(<CreateConfiguration kind="todo" today="2026-11-04" onDone={onDone} />, ipc);
  await waitFor(() => expect(screen.getByLabelText("标题")).toHaveFocus());
  expect(begin).toHaveBeenCalledWith(true, false);
  return { ipc, onDone };
}

describe("完整新增配置", () => {
  it("切换类型恢复时间与优先级草稿，并将所选项目一次提交", async () => {
    const ipc = createMemoryIpc();
    const project = await ipc.createProject("验证项目");
    await ready(ipc);
    const create = vi.spyOn(ipc, "createItem");
    const change = (name: string, value: string) =>
      fireEvent.change(screen.getByLabelText(name), { target: { value } });
    change("标题", "项目任务");
    change("简述", "保留简述");
    change("截止日期（日）", "2026-11-06");
    change("截止时间", "18:00");
    change("优先级", "high");
    await screen.findByRole("option", { name: "验证项目" });
    change("项目", project.id);
    fireEvent.click(screen.getByRole("radio", { name: "笔记" }));
    expect(screen.queryByLabelText("截止时间")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "待办" }));
    expect(screen.getByLabelText("简述")).toHaveValue("保留简述");
    expect(screen.getByLabelText("截止时间")).toHaveValue("18:00");
    expect(screen.getByLabelText("优先级")).toHaveValue("high");
    expect(screen.getByLabelText("项目")).toHaveValue(project.id);
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        brief: "保留简述",
        due: { date: "2026-11-06", time: "18:00" },
        priority: "high",
      }),
    );
  });

  it("空白标题不可提交，清空日期后禁用并清除对应时间", async () => {
    const { ipc } = await ready();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Enter", ctrlKey: true });
    expect(ipc.items).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("计划时间"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("计划日期（日）"), { target: { value: "" } });
    expect(screen.getByLabelText("计划时间")).toBeDisabled();
    expect(screen.getByLabelText("计划时间")).toHaveValue("");
    expect(screen.getByLabelText("截止时间")).toBeDisabled();
  });

  it("一次提交完整信息，普通 Enter 与输入法 Enter 不创建", async () => {
    const { ipc, onDone } = await ready();
    const create = vi.spyOn(ipc, "createItem");
    const change = (name: string, value: string) =>
      fireEvent.change(screen.getByLabelText(name), { target: { value } });
    change("标题", "  设计评审  ");
    change("简述", "准备材料");
    change("描述", "第一行\n第二行");
    change("格式", "markdown");
    change("计划日期（日）", "2026-11-05");
    change("计划时间", "09:30");
    change("截止日期（日）", "2026-11-06");
    change("截止时间", "18:00");
    change("提醒时间", "2026-11-05T09:00");
    change("优先级", "high");
    fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Enter" });
    fireEvent.keyDown(screen.getByLabelText("标题"), {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Enter", ctrlKey: true, keyCode: 229 });
    fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Escape", keyCode: 229 });
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      itemType: "todo",
      title: "设计评审",
      brief: "准备材料",
      content: "第一行\n第二行",
      contentFormat: "markdown",
      priority: "high",
      scheduled: { date: "2026-11-05", time: "09:30" },
      due: { date: "2026-11-06", time: "18:00" },
      reminderAt: new Date("2026-11-05T09:00").toISOString(),
      projectId: null,
    });
    expect(ipc.calls).not.toContain("quickCreate");
  });

  it("失败保留全部输入，重试成功；窗口失焦不关闭", async () => {
    const { ipc, onDone } = await ready(
      createMemoryIpc({ failNextCreateWith: new AppError("STORAGE_UNAVAILABLE", "busy") }),
    );
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "重试事项" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "保留详情" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("本地数据库暂时不可用");
    fireEvent.blur(window);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByLabelText("描述")).toHaveValue("保留详情");
    fireEvent.click(screen.getByRole("button", { name: "重试创建" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(ipc.items).toHaveLength(1);
  });

  it("草稿取消需确认，继续编辑恢复焦点，放弃不创建记录", async () => {
    const { ipc, onDone } = await ready();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("标题"), "未完成");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "继续编辑" })).toHaveFocus();
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("标题")).toHaveFocus();
    expect(screen.getByLabelText("标题")).toHaveValue("未完成");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "放弃内容" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(ipc.items).toHaveLength(0);
  });

  it("切换笔记保留详情，不发送不适用字段；Tab 留在页面内", async () => {
    const { ipc } = await ready();
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "笔记" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "详细记录" } });
    await user.click(screen.getByRole("radio", { name: "笔记" }));
    expect(screen.queryByLabelText("计划日期（日）")).not.toBeInTheDocument();
    expect(screen.getByLabelText("描述")).toHaveValue("详细记录");
    const save = screen.getByRole("button", { name: "创建" });
    save.focus();
    await user.tab();
    expect(screen.getByRole("radio", { name: "笔记" })).toHaveFocus();
    await user.click(save);
    await waitFor(() => expect(ipc.items).toHaveLength(1));
    expect(ipc.items[0]).toMatchObject({
      itemType: "note",
      content: "详细记录",
      scheduled: null,
      due: null,
      reminderAt: null,
      priority: "none",
    });
  });

  it("保存未完成时阻止重复创建和取消", async () => {
    const ipc = createMemoryIpc();
    const original = ipc.createItem;
    let release = () => undefined as void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = vi.spyOn(ipc, "createItem").mockImplementation(async (request) => {
      await pending;
      return original(request);
    });
    const { onDone } = await ready(ipc);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "只建一次" } });
    const input = screen.getByLabelText("标题");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("今天稍后才取到时补上默认计划日期，未改动的草稿直接取消", async () => {
    const onDone = vi.fn();
    /** 模拟 Today 查询在配置页打开后才返回。 */
    function LateToday({ kind }: { kind: ItemTypeDto }) {
      const [today, setToday] = useState<string | undefined>(undefined);
      return (
        <>
          <button type="button" onClick={() => setToday("2026-11-04")}>
            加载今天
          </button>
          <CreateConfiguration kind={kind} today={today} onDone={onDone} />
        </>
      );
    }
    renderWithProviders(<LateToday kind="todo" />);
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveFocus());
    expect(screen.getByLabelText("计划日期（日）")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "加载今天" }));
    expect(screen.getByLabelText("计划日期（日）")).toHaveValue("2026-11-04");
    fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Escape" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("从笔记切到待办时补上今天，用户清空过的日期不再被覆盖", async () => {
    const onDone = vi.fn();
    renderWithProviders(<CreateConfiguration kind="note" today="2026-11-04" onDone={onDone} />);
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveFocus());
    fireEvent.click(screen.getByRole("radio", { name: "待办" }));
    expect(screen.getByLabelText("计划日期（日）")).toHaveValue("2026-11-04");
    fireEvent.change(screen.getByLabelText("计划日期（日）"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "笔记" }));
    fireEvent.click(screen.getByRole("radio", { name: "提示" }));
    expect(screen.getByLabelText("计划日期（日）")).toHaveValue("");
  });

  it("连续新增保留类型、日期和项目，清空内容并回到标题", async () => {
    const ipc = createMemoryIpc();
    const project = await ipc.createProject("批量项目");
    const { onDone } = await ready(ipc);
    await screen.findByRole("option", { name: "批量项目" });
    fireEvent.change(screen.getByLabelText("项目"), { target: { value: project.id } });
    fireEvent.click(screen.getByRole("checkbox", { name: "创建后继续新增" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "第一项" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "只属于第一项" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已创建「第一项」");
    expect(onDone).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveFocus());
    expect(screen.getByLabelText("标题")).toHaveValue("");
    expect(screen.getByLabelText("描述")).toHaveValue("");
    expect(screen.getByLabelText("项目")).toHaveValue(project.id);
    expect(screen.getByLabelText("计划日期（日）")).toHaveValue("2026-11-04");
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "第二项" } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(ipc.items).toHaveLength(2));
    expect(ipc.items.map((item) => item.projectId)).toEqual([project.id, project.id]);
    fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Escape" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("标题长度与后端上限一致", async () => {
    await ready();
    expect(screen.getByLabelText("标题")).toHaveAttribute("maxLength", "500");
  });
});

describe("笔记的文档布局", () => {
  /** 打开一个笔记配置页并等到拿到焦点。 */
  async function openNote(ipc = createMemoryIpc()) {
    const onDone = vi.fn();
    renderWithProviders(
      <CreateConfiguration kind="note" today="2026-11-04" onDone={onDone} />,
      ipc,
    );
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveFocus());
    return { ipc, onDone };
  }

  it("用更大的文档窗口打开：大标题、整页正文、字数统计和右侧的笔记信息", async () => {
    const { ipc } = await openNote();
    expect(ipc.floatingInputLayouts).toEqual(["document"]);
    expect(screen.getByRole("dialog", { name: "新增笔记" })).toBeInTheDocument();
    const details = screen.getByRole("complementary", { name: "笔记信息" });
    expect(details).toContainElement(screen.getByLabelText("项目"));
    expect(details).toHaveTextContent("把网页或文件拖到这个窗口");
    expect(screen.queryByLabelText("简述")).not.toBeInTheDocument();

    // 标题里按 Enter 直接开始写正文。
    fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Enter" });
    expect(screen.getByLabelText("描述")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "第一行\n第二行" } });
    expect(screen.getByText("7 字 · 2 行")).toBeInTheDocument();
  });

  it("在待办和笔记之间切换：窗口换成对应布局，草稿保留", async () => {
    const { ipc } = await ready();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "会议记录" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "很长的正文" } });
    fireEvent.click(screen.getByRole("radio", { name: "笔记" }));
    await waitFor(() => expect(ipc.floatingInputLayouts).toEqual(["form", "document"]));
    expect(screen.getByLabelText("标题")).toHaveValue("会议记录");
    expect(screen.getByLabelText("描述")).toHaveValue("很长的正文");

    fireEvent.click(screen.getByRole("radio", { name: "待办" }));
    await waitFor(() => expect(ipc.floatingInputLayouts).toEqual(["form", "document", "form"]));
    expect(screen.getByLabelText("描述")).toHaveValue("很长的正文");
  });

  it("Markdown：任务行上 Ctrl+Enter 勾选而不是创建；其他位置照常创建", async () => {
    const { ipc } = await openNote();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "清单" } });
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(screen.getByRole("button", { name: "Markdown" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText(/Ctrl\+B 加粗/)).toBeInTheDocument();

    const body = screen.getByLabelText<HTMLTextAreaElement>("描述");
    fireEvent.change(body, { target: { value: "- [ ] 买菜" } });
    body.setSelectionRange(3, 3);
    fireEvent.keyDown(body, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(body).toHaveValue("- [x] 买菜"));
    expect(ipc.items).toHaveLength(0);

    fireEvent.keyDown(screen.getByLabelText("标题"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(ipc.items).toHaveLength(1));
    expect(ipc.items[0]).toMatchObject({
      itemType: "note",
      title: "清单",
      content: "- [x] 买菜",
      contentFormat: "markdown",
    });
  });
});
