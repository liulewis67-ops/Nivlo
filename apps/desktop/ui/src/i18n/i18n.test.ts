import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "./en.json";
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

/** 展开成 `a.b.c → 文案` 的平表。 */
function flatten(value: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === "string") {
    out.set(prefix, value);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      for (const [path, text] of flatten(child, prefix === "" ? key : `${prefix}.${key}`)) {
        out.set(path, text);
      }
    }
  }
  return out;
}

/** 去掉英文单复数后缀，得到基础 key。 */
function baseKey(key: string): string {
  return key.replace(/_(one|other)$/, "");
}

/** 文案里的 `{{变量}}` 集合。 */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? "").sort();
}

describe("英文文案（D-06）", () => {
  const zh = flatten(zhCN);
  const english = flatten(en);

  it("中文有的文案，英文都有（不缺失）", () => {
    const englishKeys = new Set([...english.keys()].map(baseKey));
    const missing = [...zh.keys()].filter((key) => !englishKeys.has(key));
    expect(missing).toEqual([]);
  });

  it("英文没有多余的文案", () => {
    const extra = [...english.keys()].map(baseKey).filter((key) => !zh.has(key));
    expect(extra).toEqual([]);
  });

  it("两种语言的插值变量一致", () => {
    for (const [key, text] of english) {
      const original = zh.get(baseKey(key));
      if (original === undefined) continue;
      expect(placeholders(text), key).toEqual(placeholders(original));
    }
  });

  it("日期格式在两种语言里都存在", () => {
    expect(Object.keys(en.dateFormat).sort()).toEqual(Object.keys(zhCN.dateFormat).sort());
  });
});
