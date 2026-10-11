import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { zhCN } from "date-fns/locale";
import type { CalendarEntryDto, WeekStartDto } from "@/lib/ipc";

/** Calendar 的视图。 */
export type CalendarViewKind = "month" | "week";

/**
 * 日期 → `YYYY-MM-DD`（本地日历日期，不含时区）。
 *
 * @param date 日期。
 * @returns ISO 日期文本。
 */
export function toIsoDate(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/**
 * 把后端给出的可见范围 `[from, to]` 切成一周一行的日期网格。
 *
 * 范围一定是整周（后端按「一周从哪天开始」算好），所以这里只做排版，不做日期推算。
 *
 * @param from 第一天（`YYYY-MM-DD`）。
 * @param to 最后一天（`YYYY-MM-DD`）。
 * @returns 每行 7 天的日期文本。
 */
export function buildWeeks(from: string, to: string): string[][] {
  const weeks: string[][] = [];
  const last = parseISO(to);
  let cursor = parseISO(from);
  while (cursor <= last) {
    const week: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(toIsoDate(cursor));
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * 把条目按日期分组（组内保持后端给出的顺序）。
 *
 * @param entries 后端返回的条目。
 * @returns 日期 → 当天的条目。
 */
export function groupByDate(entries: readonly CalendarEntryDto[]): Map<string, CalendarEntryDto[]> {
  const groups = new Map<string, CalendarEntryDto[]>();
  for (const entry of entries) {
    const list = groups.get(entry.date);
    if (list === undefined) groups.set(entry.date, [entry]);
    else list.push(entry);
  }
  return groups;
}

/**
 * 上一页 / 下一页：月视图翻一个月，周视图翻一周。
 *
 * 月视图保持在每月 1 日之内移动，避免 31 日翻到 30 天的月份时日期被意外截断。
 *
 * @param view 视图。
 * @param anchor 当前锚点。
 * @param direction `-1` 上一页，`1` 下一页。
 * @returns 新的锚点。
 */
export function shiftAnchor(view: CalendarViewKind, anchor: string, direction: -1 | 1): string {
  const date = parseISO(anchor);
  return toIsoDate(
    view === "month" ? addMonths(startOfMonth(date), direction) : addWeeks(date, direction),
  );
}

/**
 * 工具栏上的标题：月视图「2026年10月」，周视图「10月12日 – 10月18日」（跨年时带年份）。
 *
 * @param view 视图。
 * @param anchor 锚点。
 * @param from 可见范围的第一天。
 * @param to 可见范围的最后一天。
 * @returns 标题文字。
 */
export function titleFor(view: CalendarViewKind, anchor: string, from: string, to: string): string {
  if (view === "month") return format(parseISO(anchor), "yyyy年M月", { locale: zhCN });
  const start = parseISO(from);
  const end = parseISO(to);
  const sameYear = start.getFullYear() === end.getFullYear();
  const startText = format(start, sameYear ? "M月d日" : "yyyy年M月d日", { locale: zhCN });
  return `${startText} – ${format(end, sameYear ? "M月d日" : "yyyy年M月d日", { locale: zhCN })}`;
}

/**
 * 与后端 `visible_range` 等价的范围计算，只给内存 Mock 与测试使用（共用
 * `fixtures/dates/calendar-ranges.json` 的测试向量，保证两端语义一致）。
 *
 * @param view 视图。
 * @param anchor 锚点日期。
 * @param weekStart 一周从哪天开始。
 * @returns 可见范围的第一天与最后一天。
 */
export function visibleRange(
  view: CalendarViewKind,
  anchor: string,
  weekStart: WeekStartDto,
): { from: string; to: string } {
  const options = { weekStartsOn: weekStart === "monday" ? (1 as const) : (0 as const) };
  const date = parseISO(anchor);
  if (view === "week") {
    const from = startOfWeek(date, options);
    return { from: toIsoDate(from), to: toIsoDate(addDays(from, 6)) };
  }
  const from = startOfWeek(startOfMonth(date), options);
  const lastWeekStart = startOfWeek(endOfMonth(date), options);
  return { from: toIsoDate(from), to: toIsoDate(addDays(lastWeekStart, 6)) };
}

/**
 * 星期的表头文字（「周一」……），按一周的起始日排列。
 *
 * @param from 可见范围的第一天（一周的第一天）。
 * @returns 7 个表头。
 */
export function weekdayLabels(from: string): string[] {
  const start = parseISO(from);
  return Array.from({ length: 7 }, (_, i) => format(addDays(start, i), "eee", { locale: zhCN }));
}

/**
 * 一天的日期数字与（月初或周视图下的）月份提示。
 *
 * @param date `YYYY-MM-DD`。
 * @returns 日期数字，每月 1 日前面带月份（如「11月1日」）。
 */
export function dayLabel(date: string): string {
  const parsed = parseISO(date);
  return parsed.getDate() === 1
    ? format(parsed, "M月d日", { locale: zhCN })
    : String(parsed.getDate());
}
