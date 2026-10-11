import type { Json } from "./definition";

/** 新建脚本时的模板：对应产品文档 §12 的示例，`transform(input)` 约定参数就是输入。 */
export const SCRIPT_TEMPLATE = `// 返回值就是要创建的条目：title 必填，content / notes、type、tags 可选。
export default function transform(input) {
  return {
    title: input.title || input.text || "未命名",
    content: input.url,
    tags: ["script"],
  };
}
`;

/** 一个脚本 Step 的可编辑部分。 */
export type ScriptStep = {
  /** 源码。 */
  source: string;
  /** 脚本要访问的主机。 */
  hosts: string[];
};

/**
 * 找到定义里的第一个脚本 Step。
 *
 * @param definition 已解析的定义。
 * @returns 脚本 Step 的源码与主机；没有脚本时为 `null`。
 */
export function findScript(definition: Json): ScriptStep | null {
  const steps = Array.isArray(definition["steps"]) ? (definition["steps"] as unknown[]) : [];
  for (const step of steps) {
    if (typeof step === "object" && step !== null && (step as Json)["type"] === "script") {
      const raw = step as Json;
      const hosts = Array.isArray(raw["hosts"])
        ? (raw["hosts"] as unknown[]).filter((h): h is string => typeof h === "string")
        : [];
      return { source: typeof raw["source"] === "string" ? raw["source"] : "", hosts };
    }
  }
  return null;
}

/**
 * 把主机输入（逗号 / 空白 / 换行分隔）整理成去重的小写列表。
 *
 * @param text 用户输入。
 * @returns 主机列表。
 */
export function parseHosts(text: string): string[] {
  const hosts = text
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
  return [...new Set(hosts)];
}

/**
 * 写回脚本：更新（没有就在最前面新增）第一个脚本 Step，并让 `permissions` 覆盖它声明的主机。
 *
 * 脚本的主机必须是 Workflow 权限的子集，所以这里把缺的主机补进 `permissions.hosts` 并打开
 * `network`；清空主机时不收缩权限（其他 Step 可能还在用）。
 *
 * @param definition 当前定义。
 * @param script 新的脚本。
 * @returns 新的定义（不修改入参）。
 */
export function withScript(definition: Json, script: ScriptStep): Json {
  const steps = Array.isArray(definition["steps"]) ? [...(definition["steps"] as unknown[])] : [];
  const next: Json = { type: "script", source: script.source };
  if (script.hosts.length > 0) next["hosts"] = script.hosts;
  const at = steps.findIndex(
    (step) => typeof step === "object" && step !== null && (step as Json)["type"] === "script",
  );
  if (at >= 0) steps[at] = next;
  else steps.unshift(next);

  const result: Json = { ...definition, steps };
  if (script.hosts.length > 0) {
    const permissions =
      typeof definition["permissions"] === "object" && definition["permissions"] !== null
        ? ({ ...(definition["permissions"] as Json) } as Json)
        : {};
    const existing = Array.isArray(permissions["hosts"])
      ? (permissions["hosts"] as unknown[]).filter((h): h is string => typeof h === "string")
      : [];
    const known = new Set(existing.map((h) => h.toLowerCase()));
    permissions["network"] = true;
    permissions["hosts"] = [...existing, ...script.hosts.filter((h) => !known.has(h))];
    result["permissions"] = permissions;
  }
  return result;
}

/**
 * 删除定义里的全部脚本 Step。
 *
 * @param definition 当前定义。
 * @returns 新的定义（不修改入参）。
 */
export function withoutScript(definition: Json): Json {
  const steps = Array.isArray(definition["steps"]) ? (definition["steps"] as unknown[]) : [];
  return {
    ...definition,
    steps: steps.filter(
      (step) => !(typeof step === "object" && step !== null && (step as Json)["type"] === "script"),
    ),
  };
}
