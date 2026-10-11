import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CalendarEntryDto } from "@/lib/ipc";
import {
  buildWeeks,
  dayLabel,
  groupByDate,
  shiftAnchor,
  titleFor,
  visibleRange,
  weekdayLabels,
} from "./calendar-grid";

/** 与 Rust 共用的测试向量。 */
const vectors = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../fixtures/dates/calendar-ranges.json"), "utf8"),
) as {
  cases: Array<{
    name: string;
    view: "month" | "week";
    anchor: string;
    weekStart: "monday" | "sunday";
    from: string;
    to: string;
    weeks: number;
  }>;
};

describe("共享测试向量（与 Rust 的 calendar::visible_range 一致）", () => {
  it.each(vectors.cases)("$name", (c) => {
    expect(visibleRange(c.view, c.anchor, c.weekStart)).toEqual({ from: c.from, to: c.to });
    const weeks = buildWeeks(c.from, c.to);
    expect(weeks).toHaveLength(c.weeks);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0]?.[0]).toBe(c.from);
    expect(weeks.at(-1)?.[6]).toBe(c.to);
  });
});

describe("buildWeeks", () => {
  it("按周切片，日期连续（含跨月、跨年）", () => {
    const weeks = buildWeeks("2026-12-28", "2027-01-10");
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
  });
});

describe("groupByDate", () => {
  it("按日期分组并保持组内顺序", () => {
    const entry = (id: string, date: string): CalendarEntryDto => ({
      item: {
        id,
        itemType: "todo",
        title: id,
        status: "open",
        priority: "none",
        scheduled: null,
        due: null,
      },
      date,
      kind: "scheduled",
    });
    const groups = groupByDate([
      entry("a", "2026-10-14"),
      entry("b", "2026-10-15"),
      entry("c", "2026-10-14"),
    ]);
    expect(groups.get("2026-10-14")?.map((e) => e.item.id)).toEqual(["a", "c"]);
    expect(groups.get("2026-10-15")).toHaveLength(1);
    expect(groups.get("2026-10-16")).toBeUndefined();
  });
});

describe("shiftAnchor", () => {
  it("月视图按月翻页，31 日不会跳过短月", () => {
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftAnchor("month", "2026-03-31", -1)).toBe("2026-02-01");
    expect(shiftAnchor("month", "2026-12-15", 1)).toBe("2027-01-01");
  });

  it("周视图按周翻页", () => {
    expect(shiftAnchor("week", "2026-10-14", 1)).toBe("2026-10-21");
    expect(shiftAnchor("week", "2026-01-03", -1)).toBe("2025-12-27");
  });
});

describe("标题与表头", () => {
  it("月视图与周视图（跨年带年份）", () => {
    expect(titleFor("month", "2026-10-14", "2026-09-28", "2026-11-01")).toBe("2026年10月");
    expect(titleFor("week", "2026-10-14", "2026-10-12", "2026-10-18")).toBe("10月12日 – 10月18日");
    expect(titleFor("week", "2026-12-31", "2026-12-28", "2027-01-03")).toBe(
      "2026年12月28日 – 2027年1月3日",
    );
  });

  it("表头跟随一周的起始日", () => {
    expect(weekdayLabels("2026-10-12")).toEqual([
      "周一",
      "周二",
      "周三",
      "周四",
      "周五",
      "周六",
      "周日",
    ]);
    expect(weekdayLabels("2026-10-18")[0]).toBe("周日");
  });

  it("每月 1 日带月份", () => {
    expect(dayLabel("2026-11-01")).toBe("11月1日");
    expect(dayLabel("2026-11-02")).toBe("2");
  });
});
