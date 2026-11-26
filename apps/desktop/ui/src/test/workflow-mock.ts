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
    description: "粘贴的图片变成一条笔记，图片作为附件保存在 StarDeskBox 自己的目录里。",
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
  | "exportWorkflowFile"
  | "pickWorkflowImport"
  | "importWorkflow"
  | "saveWorkflow"
  | "deleteWorkflow"
  | "dryRunWorkflow"
  | "listWorkflowRuns"
> & {
  /** 放入一条运行记录（新的在前）。 */
  seedWorkflowRun(run: WorkflowRunDto): void;
  /** 当前的 Workflow（含用户保存的）。 */
  readonly workflows: readonly WorkflowDto[];
  /** 模拟用户在文件选择框里选中的 Workflow 文件内容；`null` 表示取消选择。 */
  offerWorkflowFile(json: string | null): void;
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

  /** 内存版的「文件选择框」：下一次 `pickWorkflowImport` 读到的内容。 */
  let offered: string | null = null;

  /**
   * 模拟后端的导入预览：版本检查、改名避免覆盖、默认禁用、来源 imported。
   *
   * @param json 文件内容。
   * @returns 导入后的定义与改名前的 ID。
   */
  function previewImport(json: string): {
    definition: Record<string, unknown>;
    renamedFrom: string | null;
  } {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new AppError("WORKFLOW_INVALID", "JSON 格式不正确");
    }
    const version = (raw as Record<string, unknown> | null)?.schemaVersion;
    if (typeof version === "number" && version > 1) {
      throw new AppError(
        "WORKFLOW_INVALID",
        `这份定义使用了更新的格式（版本 ${version}），当前StarDeskBox只支持到 1，请升级StarDeskBox后再导入`,
      );
    }
    const definition: Record<string, unknown> = {
      ...parse(json),
      source: "imported",
      enabled: false,
    };
    const original = String(definition.id);
    let candidate = original;
    for (let n = 1; workflows.some((w) => w.id === candidate); n += 1) {
      candidate = n === 1 ? `${original}-imported` : `${original}-imported-${n}`;
    }
    definition.id = candidate;
    return { definition, renamedFrom: candidate === original ? null : original };
  }

  return {
    offerWorkflowFile: (json) => {
      offered = json;
    },
    exportWorkflowFile: (id) => {
      try {
        return Promise.resolve(`C:/exports/${String(find(id).id)}.workflow.json`);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    pickWorkflowImport: () => {
      if (offered === null) return Promise.resolve(null);
      try {
        const { definition, renamedFrom } = previewImport(offered);
        const steps = (definition.steps as Record<string, unknown>[]).map((s) => String(s.type));
        const permissions = (definition.permissions ?? {}) as Record<string, unknown>;
        const scripts = (definition.steps as Record<string, unknown>[]).filter(
          (s) => s.type === "script",
        );
        return Promise.resolve({
          id: String(definition.id),
          renamedFrom,
          name: String(definition.name),
          description: typeof definition.description === "string" ? definition.description : "",
          publisher: typeof definition.publisher === "string" ? definition.publisher : null,
          network: permissions.network === true,
          hosts: Array.isArray(permissions.hosts) ? (permissions.hosts as string[]) : [],
          hasScript: scripts.length > 0,
          scriptHosts: scripts.flatMap((s) =>
            Array.isArray(s.hosts) ? (s.hosts as string[]) : [],
          ),
          stepKinds: [...new Set(steps)],
          definitionJson: JSON.stringify(definition, null, 2),
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    importWorkflow: (json) => {
      try {
        const { definition } = previewImport(json);
        workflows.push(definition);
        return Promise.resolve(toDto(definition));
      } catch (error) {
        return Promise.reject(error);
      }
    },
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
        // 脚本在真实应用里由后端沙箱执行；内存版不执行任何脚本，只返回固定的结果和日志，方便测试界面。
        const script = (definition.steps as Record<string, unknown>[]).find(
          (s) => s.type === "script",
        );
        if (script !== undefined) {
          return Promise.resolve({
            items: [
              {
                itemType: "note" as const,
                title: `脚本结果：${input.value}`,
                content: null,
                inInbox: true,
                tags: ["script"],
                priority: null,
                scheduled: null,
              },
            ],
            steps: [
              {
                index: 0,
                kind: "script",
                outcome: "ok",
                durationMs: 2,
                message: null,
                logs: [`input: ${input.value}`],
              },
            ],
            error: null,
            errorAction: null,
            durationMs: 2,
          });
        }
        // 内存版没有任何已连接的集成：`integration` Step 总是「需要连接」。
        const integrationStep = (definition.steps as Record<string, unknown>[]).find(
          (s) => s.type === "integration",
        );
        if (integrationStep !== undefined) {
          const name = String(integrationStep.integration);
          return Promise.resolve({
            items: [],
            steps: [
              {
                index: 0,
                kind: "integration",
                outcome: "failed",
                durationMs: 1,
                message: `需要连接 ${name}`,
                logs: [],
              },
            ],
            error: `需要连接 ${name}`,
            errorAction: `OPEN_INTEGRATION_SETTINGS:${name}`,
            durationMs: 1,
          });
        }
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
            logs: [],
          })),
          error: null,
          errorAction: null,
          durationMs: 1,
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    listWorkflowRuns: (limit) => Promise.resolve(runs.slice(0, limit ?? 50)),
  };
}
