import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { applyForm, parseDefinition, toForm } from "./model/definition";
import { WorkflowsPage } from "./WorkflowsPage";

describe("Workflow 定义模型", () => {
  const urlWorkflow = {
    id: "user.a",
    name: "A",
    matcher: { field: "input.type", op: "equals", value: "url" },
    steps: [{ type: "createItem", itemType: "note", title: "{{ input.title }}", inInbox: true }],
  };

  it("表单往返不丢失表单之外的字段", () => {
    const definition = { ...urlWorkflow, priority: 7, permissions: { network: false } };
    const form = toForm(definition);
    expect(form).not.toBeNull();
    const next = applyForm(definition, {
      ...form!,
      itemType: "todo",
      tags: "#read, github",
    });
    expect(next.priority).toBe(7);
    expect(next.permissions).toEqual({ network: false });
    expect((next.steps as Record<string, unknown>[])[0]).toMatchObject({
      type: "createItem",
      itemType: "todo",
      tags: ["read", "github"],
    });
  });

  it("多个条件写成 all，单个条件写成叶子", () => {
    const form = toForm(urlWorkflow)!;
    const two = applyForm(urlWorkflow, {
      ...form,
      conditions: [...form.conditions, { field: "url.host", op: "equals", value: "github.com" }],
    });
    expect(two.matcher).toEqual({
      all: [
        { field: "input.type", op: "equals", value: "url" },
        { field: "url.host", op: "equals", value: "github.com" },
      ],
    });
  });

  it("表单表示不了的定义返回 null，而不是悄悄丢内容", () => {
    expect(toForm({ ...urlWorkflow, matcher: { not: urlWorkflow.matcher } })).toBeNull();
    expect(
      toForm({
        ...urlWorkflow,
        steps: [{ type: "createItem", itemType: "note", title: "x", forEach: "files" }],
      }),
    ).toBeNull();
    expect(parseDefinition("not json")).toBeNull();
  });
});

describe("Workflow 管理页", () => {
  it("内置在前分组显示，内置的可以禁用但不能直接编辑", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<WorkflowsPage />, ipc);

    const builtin = await screen.findByRole("list", { name: "内置" });
    expect(within(builtin).getAllByRole("listitem")).toHaveLength(5);

    await userEvent.click(screen.getByRole("switch", { name: "启用 网页链接" }));
    await waitFor(() =>
      expect(ipc.workflows.find((w) => w.name === "网页链接")?.enabled).toBe(false),
    );

    await userEvent.click(screen.getByRole("button", { name: /^网页链接/ }));
    expect(await screen.findByText(/内置规则不能直接修改/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("复制内置规则 → 改成带 read 标签的待办 → 保存；试运行不写入任何数据", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<WorkflowsPage />, ipc);

    await userEvent.click(await screen.findByRole("button", { name: /^网页链接/ }));
    await userEvent.click(await screen.findByRole("button", { name: "复制" }));

    // 副本出现在「我的」里并被选中，优先级比原件高。
    const mine = await screen.findByRole("list", { name: "我的" });
    expect(within(mine).getAllByRole("listitem")).toHaveLength(1);
    const copy = ipc.workflows.find((w) => w.source === "user")!;
    expect(copy.priority).toBe(10);

    await userEvent.selectOptions(await screen.findByLabelText("创建"), "todo");
    await userEvent.type(screen.getByLabelText("标签"), "read");
    // 试运行用当前草稿。
    await userEvent.type(screen.getByLabelText("样例"), "https://example.com/a");
    await userEvent.click(screen.getByRole("button", { name: "试运行" }));
    const preview = await screen.findByText("会创建 1 条：");
    expect(preview).toBeInTheDocument();
    expect(screen.getByText("#read")).toBeInTheDocument();
    expect(ipc.calls).not.toContain("createItem");
    expect(ipc.calls).not.toContain("capture");

    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = ipc.workflows.find((w) => w.id === copy.id)!;
      expect(saved.definitionJson).toContain('"read"');
      expect(saved.definitionJson).toContain('"todo"');
    });
  });

  it("保存不合法的定义时，把出错位置显示在编辑区里", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<WorkflowsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: "新建规则" }));
    await userEvent.click(await screen.findByRole("tab", { name: "JSON" }));
    const editor = screen.getByRole("textbox", { name: "JSON" });
    fireEvent.change(editor, { target: { value: '{"id":"user.bad","name":"","steps":[]}' } });
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("/name");
  });

  it("最近执行：显示状态与脱敏摘要，点开看到每一步", async () => {
    const ipc = createMemoryIpc();
    ipc.seedWorkflowRun({
      id: "r1",
      workflowId: "builtin.generic-url",
      workflowName: "网页链接",
      inputKind: "url",
      inputSummary: "example.com/a",
      status: "failed",
      errorMessage: "boom",
      itemsCreated: 1,
      durationMs: 4,
      startedAt: new Date().toISOString(),
      steps: [{ index: 0, kind: "createItem", outcome: "failed", durationMs: 2, message: "boom" }],
    });
    renderWithProviders(<WorkflowsPage />, ipc);
    await userEvent.click(await screen.findByRole("tab", { name: "最近执行" }));
    const row = await screen.findByRole("button", { name: /网页链接/ });
    expect(row).toHaveTextContent("失败");
    expect(row).toHaveTextContent("example.com/a");
    await userEvent.click(row);
    expect(await screen.findByText(/规则失败，已按默认方式保存/)).toBeInTheDocument();
    expect(screen.getByText("createItem")).toBeInTheDocument();
  });
});
