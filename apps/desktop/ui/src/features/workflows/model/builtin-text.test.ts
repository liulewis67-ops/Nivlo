import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import i18next from "i18next";
import { afterEach, describe, expect, it } from "vitest";
import { workflowText } from "./builtin-text";

/** 仓库里的内置 Workflow 定义目录。 */
const BUILTIN_DIR = join(__dirname, "../../../../../../../workflows/builtin");

/** 读出全部内置定义的 ID、名称与说明。 */
function builtins(): { id: string; name: string; description: string }[] {
  return readdirSync(BUILTIN_DIR)
    .filter((file) => file.endsWith(".workflow.json"))
    .map((file) => JSON.parse(readFileSync(join(BUILTIN_DIR, file), "utf8")) as never);
}

describe("workflowText", () => {
  afterEach(async () => {
    await i18next.changeLanguage("zh-CN");
  });

  it("中文界面原样显示定义里的文字", () => {
    const web = { id: "builtin.web-page", source: "builtin", name: "网页", description: "说明" };
    expect(workflowText(web)).toEqual({ name: "网页", description: "说明" });
  });

  it("英文界面：每个内置 Workflow 都有英文名称与说明", async () => {
    await i18next.changeLanguage("en");
    const all = builtins();
    expect(all.length).toBeGreaterThan(0);
    for (const definition of all) {
      const text = workflowText({ ...definition, source: "builtin" });
      expect(text.name, definition.id).not.toMatch(/[一-鿿]/);
      expect(text.description, definition.id).not.toMatch(/[一-鿿]/);
    }
  });

  it("用户自建、导入与复制的 Workflow 不翻译", async () => {
    await i18next.changeLanguage("en");
    const mine = { id: "builtin.web-page", source: "user", name: "我的规则", description: "" };
    expect(workflowText(mine).name).toBe("我的规则");
  });
});
