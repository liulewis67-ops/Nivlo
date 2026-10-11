import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AUTOSAVE_DELAY_MS, ItemDetailPanel } from "@/features/detail";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";

/** 创建一个待办并返回它的 ID。 */
async function seedTodo(ipc: MemoryIpc): Promise<string> {
  const item = await ipc.createItem({
    itemType: "todo",
    title: "写周报",
    content: null,
    contentFormat: "plain",
    priority: "none",
    scheduled: null,
    due: null,
    reminderAt: null,
    projectId: null,
  });
  return item.id;
}

/** 渲染详情面板，等到表单加载完成。 */
async function openPanel(ipc: MemoryIpc, id: string): Promise<void> {
  renderWithProviders(<ItemDetailPanel id={id} onClose={() => undefined} />, ipc);
  await screen.findByLabelText("标题");
}

describe("详情里的项目选择", () => {
  it("选择项目后自动保存 projectId；改回「无项目」是清除", async () => {
    const ipc = createMemoryIpc();
    const project = ipc.seedProject("支付重构");
    const id = await seedTodo(ipc);
    await openPanel(ipc, id);
    // 项目列表是异步加载的：等选项出现。
    await screen.findByRole("option", { name: "支付重构" });

    const select = screen.getByLabelText("项目");
    expect(select).toHaveValue("");
    fireEvent.change(select, { target: { value: project.id } });
    await waitFor(() => expect(ipc.updates).toHaveLength(1), {
      timeout: AUTOSAVE_DELAY_MS + 2000,
    });
    expect(ipc.updates[0]?.request).toEqual({ projectId: { kind: "set", value: project.id } });
    expect(ipc.items[0]?.projectId).toBe(project.id);

    fireEvent.change(screen.getByLabelText("项目"), { target: { value: "" } });
    await waitFor(() => expect(ipc.updates).toHaveLength(2), {
      timeout: AUTOSAVE_DELAY_MS + 2000,
    });
    expect(ipc.updates[1]?.request).toEqual({ projectId: { kind: "clear" } });
  });

  it("所属项目已经不在列表里（被归档）时仍然显示为当前值，不会被悄悄改掉", async () => {
    const ipc = createMemoryIpc();
    const project = ipc.seedProject("旧项目");
    const id = await seedTodo(ipc);
    await ipc.updateItem(id, { projectId: { kind: "set", value: project.id } });
    await ipc.archiveProject(project.id);
    await openPanel(ipc, id);

    expect(await screen.findByRole("option", { name: "已不存在的项目" })).toBeInTheDocument();
    expect(screen.getByLabelText("项目")).toHaveValue(project.id);
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 200));
    expect(ipc.updates.filter((u) => u.request.projectId !== undefined)).toHaveLength(1);
  });
});

describe("详情里的标签", () => {
  it("输入后回车添加，标签立即出现；重复与空白被忽略", async () => {
    const ipc = createMemoryIpc();
    const id = await seedTodo(ipc);
    await openPanel(ipc, id);
    const input = screen.getByLabelText("添加标签");

    fireEvent.change(input, { target: { value: "  Jira " } });
    fireEvent.keyDown(input, { key: "Enter" });
    const chips = await screen.findByRole("list", { name: "标签" });
    expect(within(chips).getByText("Jira")).toBeInTheDocument();
    expect(ipc.tags.map((t) => t.name)).toEqual(["Jira"]);

    // 忽略大小写的重复、纯空白：什么都不发生。
    fireEvent.change(screen.getByLabelText("添加标签"), { target: { value: "jira" } });
    fireEvent.keyDown(screen.getByLabelText("添加标签"), { key: "Enter" });
    fireEvent.change(screen.getByLabelText("添加标签"), { target: { value: "   " } });
    fireEvent.keyDown(screen.getByLabelText("添加标签"), { key: "Enter" });
    expect(ipc.calls.filter((c) => c === "setItemTags")).toHaveLength(1);
  });

  it("补全：只建议还没加上的已有标签，方向键 + 回车选中", async () => {
    const ipc = createMemoryIpc();
    const other = await seedTodo(ipc);
    await ipc.setItemTags(other, ["Jira", "JavaScript", "工作"]);
    const id = await seedTodo(ipc);
    await ipc.setItemTags(id, ["JavaScript"]);
    await openPanel(ipc, id);
    // 等标签列表加载完（建议依赖它）。
    await waitFor(() => expect(ipc.calls).toContain("listTags"));

    const input = screen.getByLabelText("添加标签");
    fireEvent.change(input, { target: { value: "j" } });
    const list = await screen.findByRole("listbox", { name: "标签建议" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Jira"]);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "标签" }))
          .getAllByRole("listitem")
          .map((li) => li.textContent),
      ).toEqual(["JavaScript✕", "Jira✕"]),
    );
  });

  it("点击建议添加；移除按钮与空输入框里的 Backspace 都能移除标签", async () => {
    const ipc = createMemoryIpc();
    const user = userEvent.setup();
    const other = await seedTodo(ipc);
    await ipc.setItemTags(other, ["工作", "杂项"]);
    const id = await seedTodo(ipc);
    await openPanel(ipc, id);
    await waitFor(() => expect(ipc.calls).toContain("listTags"));

    await user.type(screen.getByLabelText("添加标签"), "工");
    await user.click(await screen.findByRole("option", { name: "工作" }));
    expect(
      within(await screen.findByRole("list", { name: "标签" })).getByText("工作"),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("添加标签"), "新标签{Enter}");
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "标签" })).getAllByRole("listitem"),
      ).toHaveLength(2),
    );

    await user.click(screen.getByRole("button", { name: "移除标签「工作」" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "标签" })).getAllByRole("listitem"),
      ).toHaveLength(1),
    );

    await user.click(screen.getByLabelText("添加标签"));
    await user.keyboard("{Backspace}");
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "标签" })).not.toBeInTheDocument(),
    );
    expect((await ipc.getItemDetail(id)).tags).toEqual([]);
  });
});
