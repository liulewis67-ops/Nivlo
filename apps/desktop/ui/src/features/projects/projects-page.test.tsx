import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { OpenItemContext } from "@/features/detail";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { ProjectsPage } from "./ProjectsPage";

/** 创建一个待办，并（可选）放进项目。 */
async function seedTodo(
  ipc: MemoryIpc,
  title: string,
  options: { projectId?: string; priority?: "none" | "low" | "medium" | "high"; day?: string } = {},
): Promise<string> {
  const item = await ipc.createItem({
    itemType: "todo",
    title,
    content: null,
    contentFormat: "plain",
    priority: options.priority ?? "none",
    scheduled: options.day === undefined ? null : { date: options.day, time: null },
    due: null,
    reminderAt: null,
    projectId: options.projectId ?? null,
  });
  if (options.projectId !== undefined) {
    await ipc.updateItem(item.id, { projectId: { kind: "set", value: options.projectId } });
  }
  return item.id;
}

/** 列表里条目标题的顺序。 */
function listedTitles(): string[] {
  const list = screen.queryByRole("list", { name: "条目列表" });
  if (list === null) return [];
  return within(list)
    .queryAllByRole("listitem")
    .map((row) => row.textContent ?? "");
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("没有项目时引导新建；回车创建并立刻选中", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<ProjectsPage />, ipc);
    expect(await screen.findByText("还没有项目", { selector: "p.text-base" })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "新项目" })[0] as HTMLElement);
    const input = screen.getByLabelText("新项目名称");
    fireEvent.change(input, { target: { value: "  支付重构 " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("heading", { name: "支付重构" })).toBeInTheDocument();
    expect(ipc.projects.map((p) => p.name)).toEqual(["支付重构"]);
    expect(await screen.findByText("这个项目还是空的")).toBeInTheDocument();
  });

  it("项目里的条目按「未完成 → 优先级 → 计划日期」排序，已完成的沉底", async () => {
    const ipc = createMemoryIpc();
    const project = ipc.seedProject("支付重构");
    await seedTodo(ipc, "低", { projectId: project.id, priority: "low", day: "2026-10-01" });
    await seedTodo(ipc, "高·晚", { projectId: project.id, priority: "high", day: "2026-10-20" });
    await seedTodo(ipc, "高·早", { projectId: project.id, priority: "high", day: "2026-10-10" });
    const done = await seedTodo(ipc, "已完成", {
      projectId: project.id,
      priority: "high",
      day: "2026-10-01",
    });
    await ipc.completeItem(done);
    await seedTodo(ipc, "别的项目的事");
    renderWithProviders(<ProjectsPage />, ipc);

    await waitFor(() => expect(listedTitles()).toHaveLength(4));
    expect(listedTitles().map((text) => text.replace(/\d{2}-\d{2}$/, ""))).toEqual([
      "高·早高",
      "高·晚高",
      "低低",
      "已完成高",
    ]);
    expect(screen.queryByText("别的项目的事")).not.toBeInTheDocument();
  });

  it("侧栏里按 ↑ / ↓ 在项目之间移动并打开它", async () => {
    const ipc = createMemoryIpc();
    const first = ipc.seedProject("甲项目");
    const second = ipc.seedProject("乙项目");
    await seedTodo(ipc, "甲的事", { projectId: first.id });
    await seedTodo(ipc, "乙的事", { projectId: second.id });
    renderWithProviders(<ProjectsPage />, ipc);
    const sidebar = await screen.findByRole("navigation");
    const rows = () =>
      within(sidebar)
        .getAllByRole("button")
        .filter((button) => button.hasAttribute("data-sidebar-item"));
    await waitFor(() => expect(rows().length).toBeGreaterThanOrEqual(2));
    const [top, next] = rows();
    top?.focus();
    fireEvent.click(top as HTMLElement);
    fireEvent.keyDown(top as HTMLElement, { key: "ArrowDown" });
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-current", "true");
  });

  it("条目列表里按 ↑ / ↓ 在标题之间移动，回车打开详情", async () => {
    const ipc = createMemoryIpc();
    const project = ipc.seedProject("P");
    await seedTodo(ipc, "第一条", { projectId: project.id, priority: "high" });
    await seedTodo(ipc, "第二条", { projectId: project.id });
    const opened: string[] = [];
    renderWithProviders(
      <OpenItemContext.Provider value={(id) => opened.push(id)}>
        <ProjectsPage />
      </OpenItemContext.Provider>,
      ipc,
    );
    const first = await screen.findByRole("button", { name: "第一条" });
    const second = screen.getByRole("button", { name: "第二条" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(first).toHaveFocus();
    fireEvent.click(first);
    expect(opened).toHaveLength(1);
  });

  it("Ctrl+N 打开新建项目的输入框", async () => {
    renderWithProviders(<ProjectsPage />, createMemoryIpc());
    await screen.findByRole("navigation");
    fireEvent.keyDown(document.body, { key: "n", ctrlKey: true });
    expect(await screen.findByLabelText("新项目名称")).toHaveFocus();
  });

  it("勾选待办会完成它", async () => {
    const ipc = createMemoryIpc();
    const project = ipc.seedProject("P");
    const id = await seedTodo(ipc, "写文档", { projectId: project.id });
    renderWithProviders(<ProjectsPage />, ipc);

    fireEvent.click(await screen.findByRole("checkbox", { name: "完成「写文档」" }));
    await waitFor(() => expect(ipc.items.find((i) => i.id === id)?.status).toBe("done"));
    expect(await screen.findByRole("checkbox", { name: "重新打开「写文档」" })).toBeChecked();
  });

  it("重命名项目：回车保存，Esc 取消", async () => {
    const ipc = createMemoryIpc();
    ipc.seedProject("旧名字");
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />, ipc);
    await screen.findByRole("heading", { name: "旧名字" });

    await user.click(screen.getByRole("button", { name: "「旧名字」的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const input = screen.getByLabelText("新的名称");
    await user.clear(input);
    await user.type(input, "新名字{Enter}");
    expect(await screen.findByRole("heading", { name: "新名字" })).toBeInTheDocument();
    expect(ipc.projects[0]?.name).toBe("新名字");

    await user.click(screen.getByRole("button", { name: "「新名字」的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));
    await user.type(screen.getByLabelText("新的名称"), "乱写{Escape}");
    expect(screen.queryByLabelText("新的名称")).not.toBeInTheDocument();
    expect(ipc.projects[0]?.name).toBe("新名字");
  });

  it("归档项目：从侧栏消失并给出可撤销的提示，撤销后回来", async () => {
    const ipc = createMemoryIpc();
    ipc.seedProject("要归档的");
    ipc.seedProject("留下的");
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />, ipc);
    await screen.findByRole("heading", { name: "要归档的" });

    await user.click(screen.getByRole("button", { name: "「要归档的」的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "归档" }));
    // 选中的被归档后回落到剩下的第一个项目。
    expect(await screen.findByRole("heading", { name: "留下的" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "要归档的" })).not.toBeInTheDocument();

    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.message).toContain("要归档的");
    act(() => toast?.action?.onClick());
    expect(await screen.findByRole("button", { name: "要归档的" })).toBeInTheDocument();
  });

  it("标签：按标签过滤，显示数量；重名重命名被拒绝并提示", async () => {
    const ipc = createMemoryIpc();
    const a = await seedTodo(ipc, "甲");
    const b = await seedTodo(ipc, "乙");
    await ipc.setItemTags(a, ["Jira", "工作"]);
    await ipc.setItemTags(b, ["工作"]);
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />, ipc);

    await user.click(await screen.findByRole("button", { name: /# 工作/ }));
    expect(await screen.findByRole("heading", { name: "# 工作" })).toBeInTheDocument();
    expect(listedTitles().sort()).toEqual([
      expect.stringContaining("乙"),
      expect.stringContaining("甲"),
    ]);

    await user.click(screen.getByRole("button", { name: /# Jira/ }));
    await waitFor(() => expect(listedTitles()).toHaveLength(1));
    expect(listedTitles()[0]).toContain("甲");

    await user.click(screen.getByRole("button", { name: "「Jira」的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const input = screen.getByLabelText("新的名称");
    await user.clear(input);
    await user.type(input, "工作{Enter}");
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toContain("同名的标签"),
    );
    expect(ipc.tags.map((t) => t.name).sort()).toEqual(["Jira", "工作"]);
  });

  it("合并标签：条目并入目标标签，被合并的标签消失", async () => {
    const ipc = createMemoryIpc();
    const a = await seedTodo(ipc, "甲");
    const b = await seedTodo(ipc, "乙");
    await ipc.setItemTags(a, ["old"]);
    await ipc.setItemTags(b, ["new"]);
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />, ipc);

    await user.click(await screen.findByRole("button", { name: "「old」的更多操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "合并到…" }));
    expect(screen.getByLabelText("合并目标")).toHaveValue(
      ipc.tags.find((t) => t.name === "new")?.id,
    );
    await user.click(screen.getByRole("button", { name: "合并" }));

    await waitFor(() => expect(ipc.tags.map((t) => t.name)).toEqual(["new"]));
    expect(await screen.findByRole("heading", { name: "# new" })).toBeInTheDocument();
    await waitFor(() => expect(listedTitles()).toHaveLength(2));
  });
});
