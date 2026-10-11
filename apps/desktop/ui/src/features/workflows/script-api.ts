/** 脚本里可用的 `ctx` API 条目：补全与参考文档共用同一份数据。 */
export type ApiEntry = {
  /** 补全文本，如 `ctx.http.get`。 */
  label: string;
  /** 类型签名。 */
  detail: string;
  /** 说明。 */
  info: string;
};

/** `ctx` 的全部公开成员（实施计划 8.2）。没有列出的名字都不存在：脚本拿不到文件系统、进程、原始网络。 */
export const CTX_API: readonly ApiEntry[] = [
  {
    label: "ctx.input",
    detail: "Record<string, string>",
    info: "输入字段，如 input.title、input.url、input.text。",
  },
  { label: "ctx.vars", detail: "Record<string, string>", info: "前面的 Step 写入的变量。" },
  { label: "ctx.metadata", detail: "Record<string, string>", info: "来源信息，如 url.host。" },
  { label: "ctx.item", detail: "object", info: "当前条目的信息（预留）。" },
  { label: "ctx.utils.trim", detail: "(s: unknown) => string", info: "转成字符串并去掉首尾空白。" },
  {
    label: "ctx.utils.truncate",
    detail: "(s: unknown, n: number) => string",
    info: "最多保留 n 个字符。",
  },
  {
    label: "ctx.http.get",
    detail: "(url: string) => { status: number; body: string }",
    info: "GET 请求，只能访问「脚本主机」里声明过的主机；未授权的主机会以 PermissionDenied 失败。",
  },
  {
    label: "console.log",
    detail: "(...args: unknown[]) => void",
    info: "输出到试运行的日志（不写入运行记录）。",
  },
];

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
