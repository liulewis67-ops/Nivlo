import { describe, expect, it } from "vitest";
import { matchCommands } from "./SearchPanel";
import type { PaletteCommand } from "./SearchPanel";

/** 测试用命令。 */
function command(id: string, label: string, keywords: string[] = []): PaletteCommand {
  return { id, label, keywords, run: () => undefined };
}

const COMMANDS = [
  command("new-note", "新建笔记", ["note", "new"]),
  command("goto-notes", "前往：笔记", ["notes"]),
  command("theme", "切换到深色主题", ["theme", "dark"]),
];

/** 匹配到的命令 ID。 */
function ids(input: string): string[] {
  return matchCommands(COMMANDS, input).map((match) => match.id);
}

describe("matchCommands", () => {
  it("空输入列出全部", () => {
    expect(ids("")).toEqual(["new-note", "goto-notes", "theme"]);
    expect(ids("   ")).toEqual(["new-note", "goto-notes", "theme"]);
  });

  it("名称或匹配词里包含输入，忽略大小写", () => {
    expect(ids("笔记")).toEqual(["new-note", "goto-notes"]);
    expect(ids("DARK")).toEqual(["theme"]);
  });

  it("多个词分别出现在不同的匹配词里也算匹配", () => {
    expect(ids("new note")).toEqual(["new-note"]);
    expect(ids("note new")).toEqual(["new-note"]);
    expect(ids("new theme")).toEqual([]);
  });
});
