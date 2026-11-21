import { addDays, addMinutes, format, parse } from "date-fns";

/** 提醒预设的种类。 */
export type ReminderPresetKind = "minutes15" | "hour1" | "sameDay9" | "dayBefore9";

/** 一个可点击的预设：种类与算出来的本地时间（`YYYY-MM-DDTHH:mm`）。 */
export type ReminderPreset = {
  /** 预设种类。 */
  kind: ReminderPresetKind;
  /** 算出来的提醒时间；缺少必要的日期 / 时间时为 `null`（预设置灰）。 */
  value: string | null;
};

/** `datetime-local` 输入框使用的格式。 */
const LOCAL_FORMAT = "yyyy-MM-dd'T'HH:mm";

/** 解析本地日期 + 时间。 */
function at(date: string, time: string): Date {
  return parse(`${date} ${time.slice(0, 5)}`, "yyyy-MM-dd HH:mm", new Date());
}

/**
 * 编辑器里提醒的预设：提前 15 分钟、提前 1 小时、当天 9:00、前一天 9:00（实施计划 4.7）。
 *
 * 以「截止时间」为基准，没有截止时间时用「计划时间」（Tip 只看计划时间）：
 * * 「提前 …」需要一个具体的时间；
 * * 「9:00」只需要一个日期（截止日期优先，其次计划日期）。
 * 缺少条件的预设 `value` 为 `null`，界面里置灰并说明为什么。
 *
 * @param input 表单里的类型与日期 / 时间。
 * @returns 四个预设，顺序固定。
 */
export function reminderPresets(input: {
  itemType: "todo" | "note" | "tip";
  scheduledDate: string;
  scheduledTime: string;
  dueDate: string;
  dueTime: string;
}): ReminderPreset[] {
  const useDue = input.itemType === "todo";
  const baseTime =
    useDue && input.dueDate !== "" && input.dueTime !== ""
      ? at(input.dueDate, input.dueTime)
      : input.scheduledDate !== "" && input.scheduledTime !== ""
        ? at(input.scheduledDate, input.scheduledTime)
        : null;
  const baseDate =
    useDue && input.dueDate !== ""
      ? input.dueDate
      : input.scheduledDate !== ""
        ? input.scheduledDate
        : null;
  /** 某天（偏移若干天）的 9:00。 */
  const nineOn = (date: string | null, offsetDays: number): string | null =>
    date === null ? null : format(addDays(at(date, "09:00"), offsetDays), LOCAL_FORMAT);
  return [
    {
      kind: "minutes15",
      value: baseTime === null ? null : format(addMinutes(baseTime, -15), LOCAL_FORMAT),
    },
    {
      kind: "hour1",
      value: baseTime === null ? null : format(addMinutes(baseTime, -60), LOCAL_FORMAT),
    },
    { kind: "sameDay9", value: nineOn(baseDate, 0) },
    { kind: "dayBefore9", value: nineOn(baseDate, -1) },
  ];
}

/**
 * 后端的提醒时间点（UTC，RFC 3339）→ 编辑器里的本地时间（`YYYY-MM-DDTHH:mm`）。
 *
 * @param iso 提醒时间点；`null` 表示没有。
 * @returns 本地时间文本，没有时为空串。
 */
export function reminderToLocal(iso: string | null): string {
  return iso === null ? "" : format(new Date(iso), LOCAL_FORMAT);
}

/**
 * 编辑器里的本地时间 → 发给后端的 UTC 时间点（RFC 3339）。
 *
 * @param local 本地时间（`YYYY-MM-DDTHH:mm`），不能为空。
 * @returns UTC 时间点；无法解析时为 `null`。
 */
export function reminderToUtc(local: string): string | null {
  const parsed = parse(local, LOCAL_FORMAT, new Date());
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
