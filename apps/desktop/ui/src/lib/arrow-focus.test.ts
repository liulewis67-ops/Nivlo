import { describe, expect, it } from "vitest";
import { nextRemaining } from "./arrow-focus";

describe("nextRemaining", () => {
  const order = ["a", "b", "c", "d"];

  it("取最后一个被整理的条目后面第一条留下的", () => {
    expect(nextRemaining(order, ["b"])).toBe("c");
    expect(nextRemaining(order, ["a", "c"])).toBe("d");
    expect(nextRemaining(order, ["b", "c"])).toBe("d");
  });

  it("后面没有了就取前面最近的一条；全部整理掉时为 null", () => {
    expect(nextRemaining(order, ["d"])).toBe("c");
    expect(nextRemaining(order, ["c", "d"])).toBe("b");
    expect(nextRemaining(order, order)).toBeNull();
    expect(nextRemaining([], [])).toBeNull();
  });
});
