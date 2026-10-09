import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import zhCN from "./zh-CN.json";

/** 后端错误码登记文档的路径（仓库根目录下）。 */
const ERROR_CODES_DOC = path.resolve(
  import.meta.dirname,
  "../../../../../docs/development/error-codes.md",
);

describe("i18n 资源", () => {
  it("后端登记的每个错误码都有对应的用户文案", () => {
    const doc = readFileSync(ERROR_CODES_DOC, "utf8");
    // 只取"## 错误码"一节（到"## UI 动作"之前）中形如 | `ITEM_NOT_FOUND` | 的行。
    const section = doc.slice(doc.indexOf("## 错误码"), doc.indexOf("## UI 动作"));
    const codes = [...section.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(10);
    const messages = zhCN.error as Record<string, string>;
    for (const code of codes) {
      expect(messages, `缺少 error.${code}`).toHaveProperty(code as string);
    }
  });

  it("后端 UI 动作都有对应文案", () => {
    expect(zhCN.errorAction).toHaveProperty("OPEN_DIAGNOSTICS");
  });
});
