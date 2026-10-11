import { describe, expect, it } from "vitest";
import type { TodayItemDto } from "@/lib/ipc";
import { dueStatus } from "./due-status";

/** 构造一个带截止日期的条目。 */
function withDue(date: string | null): TodayItemDto {
  return {
    id: "a",
    itemType: "todo",
    title: "t",
    status: "open",
    priority: "none",
    scheduled: null,
    due: date === null ? null : { date, time: null },
    isOverdue: false,
  };
}

describe("dueStatus", () => {
  it("已过截止 / 今天 / 明天 / 更远 / 没有", () => {
    expect(dueStatus(withDue("2026-10-09"), "2026-10-10")).toBe("overdue");
    expect(dueStatus(withDue("2026-10-10"), "2026-10-10")).toBe("today");
    expect(dueStatus(withDue("2026-10-11"), "2026-10-10")).toBe("tomorrow");
    expect(dueStatus(withDue("2026-10-12"), "2026-10-10")).toBeNull();
    expect(dueStatus(withDue(null), "2026-10-10")).toBeNull();
  });

  it("月末与跨年的「明天」", () => {
    expect(dueStatus(withDue("2026-11-01"), "2026-10-31")).toBe("tomorrow");
    expect(dueStatus(withDue("2027-01-01"), "2026-12-31")).toBe("tomorrow");
  });
});
