import { differenceInCalendarDays, parseISO } from "date-fns";
import i18next from "i18next";
import { formatDate } from "@/lib/date-format";
import type { DatePointDto, ItemDto } from "@/lib/ipc";

/**
 * 日期点的简短说明：今天 / 明天 / 昨天，其余为「10月30日」（不在今年时带年份）；
 * 有时间时附上「15:00」。
 *
 * @param point 日期点。
 * @param today 今天（本地）。
 * @returns 说明文字。
 */
export function dayLabel(point: DatePointDto, today: Date): string {
  const date = parseISO(point.date);
  const days = differenceInCalendarDays(date, today);
  const day =
    days === 0
      ? i18next.t("quickCreate.relative.today")
      : days === 1
        ? i18next.t("quickCreate.relative.tomorrow")
        : days === -1
          ? i18next.t("search.meta.yesterday")
          : formatDate(
              date,
              date.getFullYear() === today.getFullYear() ? "monthDay" : "yearMonthDay",
            );
  return point.time === null ? day : `${day} ${point.time.slice(0, 5)}`;
}

/**
 * 搜索结果右侧的元信息，让同名的条目也能一眼分开：项目、收集箱、完成状态或计划 / 截止日期，
 * 按这个顺序，缺的跳过。已完成的不再显示日期。
 *
 * @param item 条目。
 * @param today 今天（本地）。
 * @param projectName 由项目 ID 查名称；查不到（已归档、还没加载）时不显示项目。
 * @returns 依次显示的几段文字。
 */
export function itemMeta(
  item: ItemDto,
  today: Date,
  projectName: (id: string) => string | undefined,
): string[] {
  const parts: string[] = [];
  const project = item.projectId === null ? undefined : projectName(item.projectId);
  if (project !== undefined) parts.push(project);
  if (item.inInbox) parts.push(i18next.t("search.meta.inbox"));
  if (item.status === "done") {
    parts.push(i18next.t("search.meta.done"));
    return parts;
  }
  if (item.scheduled !== null) parts.push(dayLabel(item.scheduled, today));
  if (item.due !== null) {
    parts.push(i18next.t("search.meta.due", { date: dayLabel(item.due, today) }));
  }
  return parts;
}
