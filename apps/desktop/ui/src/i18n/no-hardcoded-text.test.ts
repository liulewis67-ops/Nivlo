import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/** 源码根目录（本文件在 `src/i18n/` 下）。 */
const SRC = join(__dirname, "..");

/**
 * 允许出现中文的文件，各有原因：
 * * 日期短语解析器要认「明天」「下午3点」这样的中文输入；
 * * 脚本模板是用户自己编辑的代码，里面的默认值是示例；
 * * 入口的挂载失败只出现在开发者控制台。
 */
const ALLOWED = new Set([
  "features/quick-create/model/date-phrase.ts",
  "features/workflows/model/script.ts",
  "main.tsx",
]);

/** 不检查的目录：生成的 Binding、文案本身、测试工具。 */
const SKIPPED_DIRS = new Set(["bindings", "i18n", "test"]);

/**
 * 列出需要检查的源码文件（相对 `src/`，用 / 分隔）。
 *
 * @param dir 当前目录。
 * @returns 文件列表。
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
    return [relative(SRC, path).split(sep).join("/")];
  });
}

/**
 * 找出一个文件里不在注释中的中文行。
 *
 * @param text 文件内容。
 * @returns 「行号: 内容」列表。
 */
function hardcodedLines(text: string): string[] {
  const found: string[] = [];
  let inBlock = false;
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("/*")) inBlock = true;
    const comment =
      inBlock || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("{/*");
    if (trimmed.includes("*/")) inBlock = false;
    if (comment) return;
    if (/[\u4e00-\u9fff]/.test(line.replace(/\/\/.*$/, ""))) found.push(`${index + 1}: ${trimmed}`);
  });
  return found;
}

describe("界面文案", () => {
  it("界面代码里没有写死的中文：所有文案都走 i18n，切换到英文时不会漏", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) =>
        hardcodedLines(readFileSync(join(SRC, file), "utf8")).map((line) => `${file}:${line}`),
      );
    expect(offenders).toEqual([]);
  });
});
