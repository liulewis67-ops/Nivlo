import i18next from "i18next";

/** 脚本里可用的 `ctx` API 条目：补全与参考文档共用同一份数据。 */
export type ApiEntry = {
  /** 补全文本，如 `ctx.http.get`。 */
  label: string;
  /** 类型签名。 */
  detail: string;
  /** 说明。 */
  info: string;
};

/** `ctx` 的成员与签名；说明文字在 i18n 的 `workflows.scriptApi.<key>` 里。 */
const CTX_MEMBERS: readonly { key: string; label: string; detail: string }[] = [
  { key: "input", label: "ctx.input", detail: "Record<string, string>" },
  { key: "vars", label: "ctx.vars", detail: "Record<string, string>" },
  { key: "metadata", label: "ctx.metadata", detail: "Record<string, string>" },
  { key: "item", label: "ctx.item", detail: "object" },
  { key: "trim", label: "ctx.utils.trim", detail: "(s: unknown) => string" },
  { key: "truncate", label: "ctx.utils.truncate", detail: "(s: unknown, n: number) => string" },
  {
    key: "httpGet",
    label: "ctx.http.get",
    detail: "(url: string) => { status: number; body: string }",
  },
  { key: "log", label: "console.log", detail: "(...args: unknown[]) => void" },
];

/**
 * `ctx` 的全部公开成员（实施计划 8.2），说明按当前界面语言。没有列出的名字都不存在：
 * 脚本拿不到文件系统、进程、原始网络。
 *
 * @returns 补全与参考文档共用的条目。
 */
export function ctxApi(): ApiEntry[] {
  return CTX_MEMBERS.map(({ key, label, detail }) => ({
    label,
    detail,
    info: i18next.t(`workflows.scriptApi.${key}`),
  }));
}

/** 脚本入口与返回值的 TypeScript 声明，在编辑器的参考面板里展示。 */
export const CTX_DTS = `declare const console: { log(...args: unknown[]): void };

interface ScriptContext {
  input: Record<string, string>;
  vars: Record<string, string>;
  metadata: Record<string, string>;
  item: object;
  utils: {
    trim(s: unknown): string;
    truncate(s: unknown, n: number): string;
  };
  http: { get(url: string): { status: number; body: string } };
}

interface ItemResult {
  title: string;            // 必填，非空
  content?: string;         // 或 notes
  type?: "todo" | "note" | "tip";
  tags?: string[];
}

// 两种入口写法任选其一：
export default async function (ctx: ScriptContext): Promise<ItemResult> { /* ... */ }
export default function transform(input: Record<string, string>): ItemResult { /* ... */ }
`;
