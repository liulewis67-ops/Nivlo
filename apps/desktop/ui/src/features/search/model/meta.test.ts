import { describe, expect, it } from "vitest";
import { dayLabel, itemMeta } from "./meta";
import type { ItemDto } from "@/lib/ipc";

/** 2026-10-27（周二）中午。 */
const TODAY = new Date(2026, 9, 27, 12);

/** 一条默认的待办，按需覆盖字段。 */
function item(overrides: Partial<ItemDto> = {}): ItemDto {
  return {
    id: "1",
    itemType: "todo",
    title: "t",
    brief: null,
    content: null,
    contentFormat: "plain",
    status: "open",
    priority: "none",
    scheduled: null,
    due: null,
    reminderAt: null,
    projectId: null,
    inInbox: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

describe("dayLabel", () => {
  it("今天 / 明天 / 昨天用相对说法，其余用月日，跨年带年份", () => {
    expect(dayLabel({ date: "2026-10-27", time: null }, TODAY)).toBe("今天");
    expect(dayLabel({ date: "2026-10-28", time: null }, TODAY)).toBe("明天");
    expect(dayLabel({ date: "2026-10-26", time: null }, TODAY)).toBe("昨天");
    expect(dayLabel({ date: "2026-11-03", time: null }, TODAY)).toBe("11月3日");
    expect(dayLabel({ date: "2027-01-05", time: null }, TODAY)).toBe("2027年1月5日");
  });

  it("有时间时附上时:分", () => {
    expect(dayLabel({ date: "2026-10-28", time: "15:00:00" }, TODAY)).toBe("明天 15:00");
  });
});

describe("itemMeta", () => {
  const names = (id: string) => (id === "p1" ? "StarDeskBox 发布" : undefined);

  it("依次给出项目、收集箱、计划与截止日期", () => {
    expect(
      itemMeta(
        item({
          projectId: "p1",
          scheduled: { date: "2026-10-28", time: null },
          due: { date: "2026-10-30", time: null },
        }),
        TODAY,
        names,
      ),
    ).toEqual(["StarDeskBox 发布", "明天", "截止 10月30日"]);
    expect(itemMeta(item({ inInbox: true }), TODAY, names)).toEqual(["收集箱"]);
  });

  it("已完成的只标「已完成」，不再显示日期", () => {
    expect(
      itemMeta(
        item({ status: "done", scheduled: { date: "2026-10-20", time: null } }),
        TODAY,
        names,
      ),
    ).toEqual(["已完成"]);
  });

  it("标签以 # 开头，最多两个，多的显示 +N", () => {
    expect(itemMeta(item(), TODAY, names, ["工作"])).toEqual(["#工作"]);
    expect(itemMeta(item(), TODAY, names, ["a", "b", "c", "d"])).toEqual(["#a #b +2"]);
  });

  it("查不到名称的项目（已归档、未加载）不显示", () => {
    expect(itemMeta(item({ projectId: "gone" }), TODAY, names)).toEqual([]);
  });
});
