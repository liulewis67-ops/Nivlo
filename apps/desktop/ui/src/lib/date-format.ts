import { format, formatDistanceToNowStrict } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";
import type { Locale } from "date-fns";
import i18next from "i18next";

/** [`formatDate`] 支持的格式名；具体写法在 i18n 的 `dateFormat` 里，随语言变化。 */
export type DateFormatKey =
  | "monthDay"
  | "monthDayWeekday"
  | "monthDayWeekdayShort"
  | "yearMonth"
  | "yearMonthDay"
  | "weekdayShort";

/**
 * 当前界面语言对应的 date-fns Locale。
 *
 * @returns 中文界面用 `zhCN`，其余用 `enUS`。
 */
export function dateLocale(): Locale {
  return i18next.language.startsWith("zh") ? zhCN : enUS;
}

/**
 * 按当前界面语言格式化日期（「10月14日」/「Oct 14」）。
 *
 * @param date 日期。
 * @param key 格式名。
 * @returns 格式化后的文本。
 */
export function formatDate(date: Date, key: DateFormatKey): string {
  return format(date, i18next.t(`dateFormat.${key}`), { locale: dateLocale() });
}

/**
 * 「3 小时前」/「3 hours ago」。
 *
 * @param date 过去的时间点。
 * @param addSuffix 是否带「前」/「ago」。
 * @returns 相对时间文本。
 */
export function distanceToNow(date: Date, addSuffix = false): string {
  return formatDistanceToNowStrict(date, { locale: dateLocale(), addSuffix });
}
