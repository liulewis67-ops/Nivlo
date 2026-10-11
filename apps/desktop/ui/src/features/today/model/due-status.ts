import { addDays, format, parseISO } from "date-fns";
import type { TodayItemDto } from "@/lib/ipc";

/** 截止日期相对「今天」的状态。 */
export type DueStatus = "overdue" | "today" | "tomorrow";

/**
 * 一条待办的截止状态（实施计划 4.7）：已过截止、今天截止、明天截止；更远或没有截止日期为 `null`。
 *
 * 只比较日期（本地日历日期），所以悬浮窗与主窗口对同一条待办的标记永远一致。
 * 「今天」取自后端的 Today 视图（用户时区），前端不读系统时间。
 *
 * @param item Today 条目。
 * @param today 今天（`YYYY-MM-DD`）。
 * @returns 截止状态。
 */
export function dueStatus(item: TodayItemDto, today: string): DueStatus | null {
  const due = item.due?.date;
  if (due === undefined) return null;
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due === format(addDays(parseISO(today), 1), "yyyy-MM-dd") ? "tomorrow" : null;
}
