import { beforeEach, describe, expect, it } from "vitest";
import {
  RECENT_COMMANDS_KEY,
  RECENT_COMMANDS_LIMIT,
  rankByRecent,
  readRecentCommands,
  rememberCommand,
} from "./recent-commands";

describe("最近用过的命令", () => {
  beforeEach(() => {
    window.localStorage.removeItem(RECENT_COMMANDS_KEY);
  });

  it("记下的命令挪到最前面，只保留最近几条", () => {
    rememberCommand("a");
    rememberCommand("b");
    rememberCommand("a");
    expect(readRecentCommands()).toEqual(["a", "b"]);
    for (let index = 0; index < 10; index += 1) rememberCommand(`c${index}`);
    expect(readRecentCommands()).toHaveLength(RECENT_COMMANDS_LIMIT);
    expect(readRecentCommands()[0]).toBe("c9");
  });

  it("内容损坏时当作没有记录", () => {
    window.localStorage.setItem(RECENT_COMMANDS_KEY, "{oops");
    expect(readRecentCommands()).toEqual([]);
    window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify({ not: "a list" }));
    expect(readRecentCommands()).toEqual([]);
  });

  it("排序：最近用过的按先后排在前面，其余保持原来的顺序", () => {
    const items = ["x", "y", "z", "w"].map((id) => ({ id }));
    expect(rankByRecent(items, ["z", "w"]).map((item) => item.id)).toEqual(["z", "w", "x", "y"]);
    expect(rankByRecent(items, []).map((item) => item.id)).toEqual(["x", "y", "z", "w"]);
    expect(rankByRecent(items, ["gone"]).map((item) => item.id)).toEqual(["x", "y", "z", "w"]);
  });
});
