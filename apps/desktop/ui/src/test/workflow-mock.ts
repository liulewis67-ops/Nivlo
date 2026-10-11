import { AppError } from "@/lib/errors";
import type {
  DryRunInputDto,
  DryRunResultDto,
  IpcClient,
  WorkflowDto,
  WorkflowRunDto,
} from "@/lib/ipc";

/** 内置 Workflow 的定义（与 `workflows/builtin/*.workflow.json` 保持一致的形状）。 */
const BUILTINS: Record<string, unknown>[] = [
  {
    schemaVersion: 1,
    id: "builtin.generic-text",
    name: "文字",
    description: "收集到的文字变成待办：第一行是标题，其余放进内容，进入收集箱等待整理。",
    version: 1,
    priority: 0,
    enabled: true,
    source: "builtin",
    matcher: { field: "input.type", op: "equals", value: "text" },
    steps: [
      {
        type: "createItem",
        itemType: "todo",
        title: "{{ input.title }}",
        content: "{{ input.extra }}",
        inInbox: true,
      },
    ],
  },
  {
    schemaVersion: 1,
    id: "builtin.generic-url",
    name: "网页链接",
    description: "收集到的网址变成笔记：标题是「域名/路径」，网址放进内容，进入收集箱等待整理。",
    version: 1,
    priority: 0,
    enabled: true,
    source: "builtin",
    matcher: { field: "input.type", op: "equals", value: "url" },
    steps: [
      {
        type: "createItem",
        itemType: "note",
        title: "{{ input.title }}",
        content: "{{ input.url }}",
        inInbox: true,
      },
    ],
  },
  {
    schemaVersion: 1,
    id: "builtin.web-page",
    name: "网页（补全标题和摘要）",
    description:
      "网址先立刻变成笔记，随后在后台读取网页的标题和摘要补全进去。读取失败或没有网络时，笔记保持「域名/路径」标题，不受影响。",
    version: 1,
    priority: 1,
    enabled: true,
    source: "builtin",
    matcher: { field: "input.type", op: "equals", value: "url" },
    permissions: { network: true, hosts: ["*"] },
    steps: [
      { type: "http", url: "{{ input.url }}", into: "page", optional: true },
      { type: "htmlMeta", from: "vars.page", into: "meta", optional: true },
      {
        type: "createItem",
        itemType: "note",
        title: "{{ vars.meta_title | default(input.title) | truncate(120) }}",
        content: "{{ input.url }}",
        inInbox: true,
      },
    ],
  },
  {
    schemaVersion: 1,
    id: "builtin.generic-file",
    name: "文件",
    description: "收集到的文件（可以多个）每个变成一条笔记，只保存文件的引用，不复制文件。",
    version: 1,
    priority: 0,
    enabled: true,
    source: "builtin",
    matcher: {
      any: [
        { field: "input.type", op: "equals", value: "file" },
        { field: "input.type", op: "equals", value: "files" },
      ],
    },
    steps: [
      {
        type: "createItem",
        itemType: "note",
        title: "{{ file.name }}",
        inInbox: true,
        forEach: "files",
      },
    ],
  },
  {
    schemaVersion: 1,
    id: "builtin.generic-image",
    name: "图片",
    description: "粘贴的图片变成一条笔记，图片作为附件保存在 Nivlo 自己的目录里。",
    version: 1,
    priority: 0,
    enabled: true,
    source: "builtin",
    matcher: { field: "input.type", op: "equals", value: "image" },
    steps: [{ type: "createItem", itemType: "note", title: "图片", inInbox: true }],
  },
];

/** 内存版 Workflow IPC 额外暴露的测试能力。 */
export type WorkflowMock = Pick<
  IpcClient,
  | "listWorkflows"
  | "setWorkflowEnabled"
  | "setWorkflowPriority"
  | "duplicateWorkflow"
  | "confirmScriptPermissions"
  | "saveWorkflow"
  | "deleteWorkflow"
  | "dryRunWorkflow"
  | "listWorkflowRuns"
> & {
  /** 放入一条运行记录（新的在前）。 */
  seedWorkflowRun(run: WorkflowRunDto): void;
  /** 当前的 Workflow（含用户保存的）。 */
  readonly workflows: readonly WorkflowDto[];
};

/** 已确认过脚本权限的 Workflow ID（测试内存里的授权记录）。 */
const confirmedScripts = new Set<string>();

/**
 * 脚本权限状态与声明的主机。
 *
 * @param definition 定义。
 * @returns DTO 里的两个脚本字段。
 */
function scriptInfo(definition: Record<string, unknown>): {
  scriptStatus: string;
  scriptHosts: string[];
} {
  const steps = Array.isArray(definition.steps)
    ? (definition.steps as Record<string, unknown>[])
    : [];
  const scripts = steps.filter((step) => step.type === "script");
  if (scripts.length === 0) return { scriptStatus: "none", scriptHosts: [] };
  const hosts = scripts.flatMap((step) =>
    Array.isArray(step.hosts) ? (step.hosts as string[]) : [],
  );
  return {
    scriptStatus: confirmedScripts.has(String(definition.id)) ? "confirmed" : "needsConfirmation",
    scriptHosts: [...new Set(hosts.map((h) => h.toLowerCase()))].sort(),
  };
}

/**
 * 由定义对象构造 DTO。
 *
 * @param definition 定义。
 * @returns DTO。
 */
function toDto(definition: Record<string, unknown>): WorkflowDto {
  const source = typeof definition.source === "string" ? definition.source : "user";
  return {
    id: String(definition.id),
    name: String(definition.name),
    description: typeof definition.description === "string" ? definition.description : "",
    source,
    enabled: definition.enabled !== false,
    priority: typeof definition.priority === "number" ? definition.priority : 0,
    version: typeof definition.version === "number" ? definition.version : 1,
    readOnly: source === "builtin",
    definitionJson: JSON.stringify(definition, null, 2),
    updatedAt: "2026-10-10T08:00:00Z",
    ...scriptInfo(definition),
  };
}

/**
 * 渲染 `{{ var }}` 模板（只支持变量，够试运行预览用）。
 *
 * @param template 模板。
 * @param scope 变量。
 * @returns 渲染结果。
 */
function render(template: string, scope: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)[^}]*\}\}/g, (_, name: string) => scope[name] ?? "");
}

/**
 * 样例输入 → 模板变量。
 *
 * @param input 样例。
 * @returns 变量表与输入种类。
 */
function scopeOf(input: DryRunInputDto): Record<string, string> {
  const value = input.value.trim();
  if (input.kind === "file") {
    const name = value.split(/[\\/]/).pop() ?? value;
    return { "input.type": "file", "file.name": name, "input.title": name };
  }
  if (/^https?:\/\//.test(value)) {
    const url = new URL(value);
    return {
      "input.type": "url",
      "input.url": value,
      "input.title": `${url.host.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`,
      "url.host": url.host,
      "now.date": "2026-10-10",
    };
  }
  const [first = "", ...rest] = value.split("\n");
  return {
    "input.type": "text",
    "input.text": value,
    "input.title": first,
    "input.extra": rest.length > 0 ? value : "",
    "now.date": "2026-10-10",
  };
}

/**
 * 创建内存版 Workflow IPC：行为与后端的 Application 层保持一致（只读内置、复制、校验、试运行不写入）。
 *
 * @returns 方法集合与测试辅助。
 */
export function createWorkflowMock(): WorkflowMock {
  const workflows: Record<string, unknown>[] = BUILTINS.map((w) => ({ ...w }));
  const runs: WorkflowRunDto[] = [];

  /**
   * 按 ID 找 Workflow。
   *
   * @param id Workflow ID。
   * @returns 定义对象。
   */
  function find(id: string): Record<string, unknown> {
    const found = workflows.find((w) => w.id === id);
    if (found === undefined) throw new AppError("WORKFLOW_NOT_FOUND", id);
    return found;
  }

  /**
   * 解析并校验定义（只做最基本的检查：JSON、ID、名称、必须有 createItem）。
   *
   * @param json 定义文本。
   * @returns 定义对象。
   */
  function parse(json: string): Record<string, unknown> {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      throw new AppError("WORKFLOW_INVALID", "JSON 格式不正确");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AppError("WORKFLOW_INVALID", "定义必须是一个 JSON 对象");
    }
    const definition = value as Record<string, unknown>;
    if (typeof definition.id !== "string" || !/^[a-z0-9._-]+$/.test(definition.id)) {
      throw new AppError("WORKFLOW_INVALID", "/id：ID 只能包含小写字母、数字、点、减号和下划线");
    }
    if (typeof definition.name !== "string" || definition.name.trim() === "") {
      throw new AppError("WORKFLOW_INVALID", "/name：名称不能为空");
    }
    const steps = Array.isArray(definition.steps) ? definition.steps : [];
    if (
      !steps.some((s) => {
        const type = (s as Record<string, unknown>).type;
        return type === "createItem" || type === "script";
      })
    ) {
      throw new AppError("WORKFLOW_INVALID", "/steps：Workflow 至少需要一个 createItem Step");
    }
    for (const [at, step] of steps.entries()) {
      const title = (step as Record<string, unknown>).title;
      if (typeof title === "string" && /\{\{\s*vars\.(\w+)/.test(title)) {
        const name = /\{\{\s*vars\.(\w+)/.exec(title)?.[1] ?? "";
        throw new AppError(
          "WORKFLOW_INVALID",
          `/steps/${at}/title：变量 vars.${name} 没有被任何 Step 定义`,
        );
      }
    }
    return definition;
  }

  return {
    seedWorkflowRun: (run) => {
      runs.unshift(run);
    },
    get workflows() {
      return workflows.map(toDto);
    },
    listWorkflows: () => {
      const rank = (w: Record<string, unknown>): number => (w.source === "builtin" ? 0 : 1);
      const sorted = [...workflows].sort(
        (a, b) =>
          rank(a) - rank(b) ||
          Number(b.priority ?? 0) - Number(a.priority ?? 0) ||
          String(a.id).localeCompare(String(b.id)),
      );
      return Promise.resolve(sorted.map(toDto));
    },
    setWorkflowEnabled: (id, enabled) => {
      try {
        find(id).enabled = enabled;
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
    setWorkflowPriority: (id, priority) => {
      try {
        find(id).priority = priority;
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
    confirmScriptPermissions: (id) => {
      try {
        const original = find(id);
        confirmedScripts.add(String(original.id));
        return Promise.resolve(toDto(original));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    duplicateWorkflow: (id) => {
      try {
        const original = find(id);
        const base = String(original.id).replace(/^(builtin|user|imported)\./, "");
        let candidate = `user.${base}-copy`;
        for (let n = 2; workflows.some((w) => w.id === candidate); n += 1) {
          candidate = `user.${base}-copy-${n}`;
        }
        const copy = {
          ...structuredClone(original),
          id: candidate,
          name: `${String(original.name)}（副本）`,
          source: "user",
          priority: Number(original.priority ?? 0) + 10,
          enabled: true,
          version: 1,
        };
        workflows.push(copy);
        return Promise.resolve(toDto(copy));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    saveWorkflow: (json) => {
      try {
        const definition = parse(json);
        const existing = workflows.findIndex((w) => w.id === definition.id);
        if (existing >= 0 && workflows[existing]?.source === "builtin") {
          throw new AppError("WORKFLOW_READ_ONLY", "内置 Workflow 不能修改");
        }
        const saved = {
          ...definition,
          source: definition.source === "imported" ? "imported" : "user",
        };
        if (existing >= 0) workflows[existing] = saved;
        else workflows.push(saved);
        return Promise.resolve(toDto(saved));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    deleteWorkflow: (id) => {
      try {
        const found = find(id);
        if (found.source === "builtin") throw new AppError("WORKFLOW_READ_ONLY", "内置不能删除");
        workflows.splice(workflows.indexOf(found), 1);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
    dryRunWorkflow: (json, input): Promise<DryRunResultDto> => {
      try {
        if (input.value.trim() === "") throw new AppError("INVALID_INPUT", "请先输入一个样例");
        const definition = parse(json);
        const scope = scopeOf(input);
        const create = (definition.steps as Record<string, unknown>[]).find(
          (s) => s.type === "createItem",
        );
        const tags = Array.isArray(create?.tags) ? (create.tags as string[]) : [];
        return Promise.resolve({
          items: [
            {
              itemType: (create?.itemType as "todo" | "note" | "tip") ?? "note",
              title: render(String(create?.title ?? ""), scope),
              content:
                typeof create?.content === "string" ? render(create.content, scope) || null : null,
              inInbox: create?.inInbox !== false,
              tags,
              priority: null,
              scheduled:
                typeof create?.scheduled === "string" ? render(create.scheduled, scope) : null,
            },
          ],
          steps: (definition.steps as Record<string, unknown>[]).map((step, index) => ({
            index,
            kind: String(step.type),
            outcome: "ok",
            durationMs: 0,
            message: null,
          })),
          error: null,
          durationMs: 1,
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    listWorkflowRuns: (limit) => Promise.resolve(runs.slice(0, limit ?? 50)),
  };
}
