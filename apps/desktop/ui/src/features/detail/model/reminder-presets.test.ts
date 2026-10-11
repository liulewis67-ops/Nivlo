import { describe, expect, it } from "vitest";
import { reminderPresets, reminderToLocal, reminderToUtc } from "./reminder-presets";

const empty = { scheduledDate: "", scheduledTime: "", dueDate: "", dueTime: "" };

/** 把预设整理成「种类 → 值」。 */
function values(input: Parameters<typeof reminderPresets>[0]): Record<string, string | null> {
  return Object.fromEntries(reminderPresets(input).map((p) => [p.kind, p.value]));
}

describe("reminderPresets", () => {
  it("待办以截止时间为基准：提前 15 分钟 / 1 小时、当天 9:00、前一天 9:00", () => {
    expect(values({ itemType: "todo", ...empty, dueDate: "2026-10-16", dueTime: "17:30" })).toEqual(
      {
        minutes15: "2026-10-16T17:15",
        hour1: "2026-10-16T16:30",
        sameDay9: "2026-10-16T09:00",
        dayBefore9: "2026-10-15T09:00",
      },
    );
  });

  it("截止只有日期时：「提前 …」置灰，9:00 预设可用；没有截止时退回计划时间", () => {
    expect(values({ itemType: "todo", ...empty, dueDate: "2026-10-16" })).toEqual({
      minutes15: null,
      hour1: null,
      sameDay9: "2026-10-16T09:00",
      dayBefore9: "2026-10-15T09:00",
    });
    expect(
      values({ itemType: "todo", ...empty, scheduledDate: "2026-10-14", scheduledTime: "10:00" }),
    ).toMatchObject({ minutes15: "2026-10-14T09:45", sameDay9: "2026-10-14T09:00" });
  });

  it("Tip 只看计划时间，不看截止", () => {
    expect(
      values({
        itemType: "tip",
        scheduledDate: "2026-10-14",
        scheduledTime: "15:00",
        dueDate: "2026-12-01",
        dueTime: "08:00",
      }),
    ).toMatchObject({ minutes15: "2026-10-14T14:45", dayBefore9: "2026-10-13T09:00" });
  });

  it("没有任何日期时全部置灰；月初的「前一天」跨月", () => {
    expect(Object.values(values({ itemType: "todo", ...empty })).every((v) => v === null)).toBe(
      true,
    );
    expect(values({ itemType: "todo", ...empty, dueDate: "2026-11-01" }).dayBefore9).toBe(
      "2026-10-31T09:00",
    );
  });

  it("提前 15 分钟可以跨到前一天", () => {
    expect(
      values({ itemType: "todo", ...empty, dueDate: "2026-10-16", dueTime: "00:10" }).minutes15,
    ).toBe("2026-10-15T23:55");
  });
});

describe("本地时间与 UTC 互转", () => {
  it("往返一致，空值与非法值", () => {
    const utc = reminderToUtc("2026-10-14T10:30");
    expect(utc).not.toBeNull();
    expect(reminderToLocal(utc)).toBe("2026-10-14T10:30");
    expect(reminderToLocal(null)).toBe("");
    expect(reminderToUtc("")).toBeNull();
    expect(reminderToUtc("不是时间")).toBeNull();
  });
});
