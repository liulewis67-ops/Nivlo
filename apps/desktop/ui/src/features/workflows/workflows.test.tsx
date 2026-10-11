import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { applyForm, parseDefinition, toForm } from "./model/definition";
import { WorkflowsPage } from "./WorkflowsPage";

/**
 * 断言值存在并返回它（测试里代替非空断言）。
 *
 * @param value 可能为空的值。
 * @returns 非空的值。
 */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("值不应为空");
  return value;
}

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
      ...must(form),
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
    const form = must(toForm(urlWorkflow));
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
    const copy = must(ipc.workflows.find((w) => w.source === "user"));
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
      const saved = must(ipc.workflows.find((w) => w.id === copy.id));
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
      errorAction: null,
      errorMessage: "boom",
      itemsCreated: 1,
      durationMs: 4,
      startedAt: new Date().toISOString(),
      steps: [
        {
          index: 0,
          kind: "createItem",
          outcome: "failed",
          durationMs: 2,
          message: "boom",
          logs: [],
        },
      ],
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

describe("脚本权限确认", () => {
  const scriptWorkflow = JSON.stringify({
    schemaVersion: 1,
    id: "user.scripted",
    name: "脚本规则",
    matcher: { field: "input.type", op: "equals", value: "text" },
    permissions: { network: true, hosts: ["api.example.com"] },
    steps: [
      {
        type: "script",
        source: "export default () => ({ title: 'x' })",
        hosts: ["api.example.com"],
      },
    ],
  });

  it("含脚本的规则先显示需要确认，确认后变为已确认", async () => {
    const ipc = createMemoryIpc();
    await ipc.saveWorkflow(scriptWorkflow);
    renderWithProviders(<WorkflowsPage />, ipc);

    await userEvent.click(await screen.findByRole("button", { name: /^脚本规则/ }));
    expect(
      await screen.findByText(/确认它能访问的内容后才会运行：api.example.com/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "确认权限" }));
    expect(await screen.findByText(/脚本权限已确认/)).toBeInTheDocument();
    expect(ipc.calls).toContain("confirmScriptPermissions");
  });

  it("没有脚本的规则不显示权限提示", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<WorkflowsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: /^网页链接/ }));
    await screen.findByText(/内置规则不能直接修改/);
    expect(screen.queryByRole("button", { name: "确认权限" })).not.toBeInTheDocument();
  });
});

describe("脚本编辑器", () => {
  it("添加脚本 → 编辑器出现并带有模板 → 试运行显示结果与控制台输出", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<WorkflowsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: "新建规则" }));
    await userEvent.click(await screen.findByRole("tab", { name: "脚本" }));
    await userEvent.click(screen.getByRole("button", { name: "添加脚本" }));

    const editor = await screen.findByRole("textbox", { name: "脚本源码" });
    expect(editor).toHaveTextContent("export default function transform(input)");

    // 主机会并入权限：在 JSON 页签里能看到。
    await userEvent.type(screen.getByLabelText("脚本可以访问的主机"), "API.example.com");
    await userEvent.click(screen.getByRole("tab", { name: "JSON" }));
    const json = (screen.getByRole("textbox", { name: "JSON" }) as HTMLTextAreaElement).value;
    expect(json).toContain('"hosts": [\n        "api.example.com"');
    expect(json).toContain('"network": true');

    await userEvent.type(screen.getByLabelText("样例"), "你好");
    await userEvent.click(screen.getByRole("button", { name: "试运行" }));
    expect(await screen.findByText("脚本结果：你好")).toBeInTheDocument();
    expect(screen.getByLabelText("脚本控制台输出")).toHaveTextContent("input: 你好");
  });
});

describe("导入与导出", () => {
  const incoming = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      id: "user.shared",
      name: "朋友的规则",
      publisher: "Alice",
      matcher: { field: "input.type", op: "equals", value: "text" },
      permissions: { network: true, hosts: ["api.example.com"] },
      steps: [
        {
          type: "script",
          source: "export default () => ({ title: 'x' })",
          hosts: ["api.example.com"],
        },
      ],
      ...extra,
    });

  it("先展示权限，勾选确认后才能导入；导入的默认禁用且来源是 imported", async () => {
    const ipc = createMemoryIpc();
    ipc.offerWorkflowFile(incoming());
    renderWithProviders(<WorkflowsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: "导入" }));

    const panel = await screen.findByRole("region", { name: "导入自动化" });
    expect(within(panel).getByText("Alice")).toBeInTheDocument();
    expect(within(panel).getByText(/需要联网访问：api.example.com/)).toBeInTheDocument();
    expect(within(panel).getByText(/包含脚本，可能访问：api.example.com/)).toBeInTheDocument();
    const confirm = within(panel).getByRole("button", { name: "导入" });
    expect(confirm).toBeDisabled();
    expect(ipc.calls).not.toContain("importWorkflow");

    await userEvent.click(within(panel).getByRole("checkbox"));
    await userEvent.click(confirm);
    await waitFor(() => {
      const saved = must(ipc.workflows.find((w) => w.id === "user.shared"));
      expect(saved.source).toBe("imported");
      expect(saved.enabled).toBe(false);
      // 含联网脚本：导入后仍需确认脚本权限才会运行。
      expect(saved.scriptStatus).toBe("needsConfirmation");
    });
  });

  it("ID 冲突时改名而不覆盖；取消选择什么都不发生；新格式给出升级提示", async () => {
    const ipc = createMemoryIpc();
    await ipc.saveWorkflow(incoming({ name: "我自己的" }));
    ipc.offerWorkflowFile(incoming());
    renderWithProviders(<WorkflowsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: "导入" }));
    expect(await screen.findByText(/已被占用，将以 user.shared-imported 导入/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(ipc.calls).not.toContain("importWorkflow");

    ipc.offerWorkflowFile(null);
    await userEvent.click(screen.getByRole("button", { name: "导入" }));
    expect(screen.queryByRole("region", { name: "导入自动化" })).not.toBeInTheDocument();

    ipc.offerWorkflowFile(incoming({ schemaVersion: 2 }));
    await userEvent.click(screen.getByRole("button", { name: "导入" }));
    expect(await screen.findByText(/升级拾序后再导入/)).toBeInTheDocument();
  });

  it("导出调用后端并提示路径", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<WorkflowsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: /^网页链接/ }));
    await userEvent.click(await screen.findByRole("button", { name: "导出" }));
    await waitFor(() =>
      expect(ipc.calls.some((c) => c.startsWith("exportWorkflowFile:"))).toBe(true),
    );
  });
});

describe("集成失败的下一步", () => {
  it("需要连接时试运行显示「需要连接」和跳转按钮，而不是 HTTP 错误", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<WorkflowsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: "新建规则" }));
    await userEvent.click(await screen.findByRole("tab", { name: "JSON" }));
    const editor = screen.getByRole("textbox", { name: "JSON" });
    fireEvent.change(editor, {
      target: {
        value: JSON.stringify({
          schemaVersion: 1,
          id: "user.hub",
          name: "集成",
          matcher: { field: "input.type", op: "equals", value: "text" },
          permissions: { network: true, hosts: ["jira.example.com"] },
          steps: [
            { type: "integration", integration: "jira", operation: "issue", into: "j" },
            { type: "createItem", itemType: "todo", title: "x" },
          ],
        }),
      },
    });
    await userEvent.type(screen.getByLabelText("样例"), "APP-1");
    await userEvent.click(screen.getByRole("button", { name: "试运行" }));
    expect((await screen.findAllByText(/需要连接 jira/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/HTTP/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开设置，连接 jira" })).toBeInTheDocument();
  });
});
