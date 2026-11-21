import { addDays, format, getDay, parseISO } from "date-fns";
import i18next from "i18next";
import { formatDate } from "@/lib/date-format";

/** 解析出的日期 + 可选时间（本地日历日期，不含时区）。 */
export type ParsedSchedule = {
  /** 日期 `YYYY-MM-DD`。 */
  date: string;
  /** 时间 `HH:MM`；`null` 表示全天。 */
  time: string | null;
};

/** 从标题里识别出日期 / 时间短语的结果。 */
export type DatePhraseResult = {
  /** 识别出的计划。 */
  schedule: ParsedSchedule;
  /** 去掉日期 / 时间短语之后的标题（已整理空白与多余的连接词）。 */
  title: string;
  /** 面向用户的说明，如「明天 · 10月15日 周四 15:00」。 */
  label: string;
  /** 被识别的短语在原文里的位置区间（可能有两段：日期和时间）。 */
  spans: ReadonlyArray<readonly [number, number]>;
  /** 最后一个被识别的短语是否正好在文本末尾（用于 Backspace 取消解析）。 */
  endsAtTail: boolean;
};

/** 中文星期数字 → 0（周日）..6（周六）。 */
const ZH_WEEKDAY: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

/** 英文星期名 → 0（周日）..6（周六）。 */
const EN_WEEKDAY: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/** 英文月份名 → 1..12。 */
const EN_MONTH: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/** 一个匹配到的日期 / 时间短语。 */
type Token<T> = {
  /** 起点（含）。 */
  start: number;
  /** 终点（不含）。 */
  end: number;
  /** 解析出的值。 */
  value: T;
};

/**
 * 格式化日期为 `YYYY-MM-DD`。
 *
 * @param date 日期。
 * @returns 文本。
 */
function iso(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/**
 * 以 `today` 为基准，下一个（含今天）星期 `weekday` 的日期。
 *
 * @param today 今天。
 * @param weekday 0（周日）..6（周六）。
 * @returns 日期。
 */
function nextWeekday(today: Date, weekday: number): Date {
  return addDays(today, (weekday - getDay(today) + 7) % 7);
}

/**
 * 「下周X」「下下周X」：把 `today` 所在周（周一起算）往后推 `weeks` 周，取其中的星期 `weekday`。
 *
 * @param today 今天。
 * @param weekday 0（周日）..6（周六）。
 * @param weeks 推几周（下周为 1）。
 * @returns 日期。
 */
function weekdayInWeek(today: Date, weekday: number, weeks: number): Date {
  const mondayOffset = (getDay(today) + 6) % 7;
  const monday = addDays(today, -mondayOffset + weeks * 7);
  return addDays(monday, (weekday + 6) % 7);
}

/**
 * 构造一个日期并校验它真实存在（拒绝 2 月 30 日之类）。
 *
 * @param year 年。
 * @param month 月（1..12）。
 * @param day 日。
 * @returns 日期；不存在时为 `null`。
 */
function validDate(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

/**
 * 「X月X日」没写年份时：今年；已经过去（早于今天）就是明年。
 *
 * @param today 今天。
 * @param month 月。
 * @param day 日。
 * @returns 日期；日期不存在时为 `null`。
 */
function monthDay(today: Date, month: number, day: number): Date | null {
  const thisYear = validDate(today.getFullYear(), month, day);
  if (thisYear === null) return null;
  return thisYear < today ? validDate(today.getFullYear() + 1, month, day) : thisYear;
}

/**
 * 明确写了年份的日期如果已经过去，就不当作计划（「整理 2025年10月1日 的文件」是标题的一部分）。
 *
 * @param date 日期。
 * @param today 今天。
 * @returns 今天或将来的日期；已经过去（或不存在）为 `null`。
 */
function notPast(date: Date | null, today: Date): Date | null {
  return date !== null && date >= today ? date : null;
}

/** 中文日期短语的正则：相对日 / 星期 / 月日 / 完整日期，按优先级排列。 */
const ZH_DATE_PATTERNS: Array<{
  pattern: RegExp;
  resolve: (match: RegExpExecArray, today: Date) => Date | null;
}> = [
  {
    pattern: /(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/,
    resolve: (m, today) => notPast(validDate(Number(m[1]), Number(m[2]), Number(m[3])), today),
  },
  {
    pattern: /(?<!年|\d)(\d{1,2})月(\d{1,2})[日号]/,
    resolve: (m, today) => monthDay(today, Number(m[1]), Number(m[2])),
  },
  { pattern: /大后天/, resolve: (_m, today) => addDays(today, 3) },
  { pattern: /后天/, resolve: (_m, today) => addDays(today, 2) },
  { pattern: /明天|明日/, resolve: (_m, today) => addDays(today, 1) },
  { pattern: /今天|今日/, resolve: (_m, today) => today },
  {
    pattern: /下下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/,
    resolve: (m, today) => weekdayInWeek(today, ZH_WEEKDAY[m[1] ?? ""] ?? 0, 2),
  },
  {
    pattern: /下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/,
    resolve: (m, today) => weekdayInWeek(today, ZH_WEEKDAY[m[1] ?? ""] ?? 0, 1),
  },
  {
    pattern: /(?:本|这)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/,
    resolve: (m, today) => nextWeekday(today, ZH_WEEKDAY[m[1] ?? ""] ?? 0),
  },
  {
    pattern: /(?:周|星期|礼拜)([一二三四五六日天])/,
    resolve: (m, today) => nextWeekday(today, ZH_WEEKDAY[m[1] ?? ""] ?? 0),
  },
];

/** 英文日期短语的正则（统一忽略大小写）。 */
const EN_DATE_PATTERNS: Array<{
  pattern: RegExp;
  resolve: (match: RegExpExecArray, today: Date) => Date | null;
}> = [
  {
    pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/i,
    resolve: (m, today) => notPast(validDate(Number(m[1]), Number(m[2]), Number(m[3])), today),
  },
  {
    pattern:
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i,
    resolve: (m, today) => {
      const month = EN_MONTH[(m[1] ?? "").toLowerCase()];
      if (month === undefined) return null;
      return m[3] === undefined
        ? monthDay(today, month, Number(m[2]))
        : notPast(validDate(Number(m[3]), month, Number(m[2])), today);
    },
  },
  {
    pattern:
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
    resolve: (m, today) => {
      const month = EN_MONTH[(m[2] ?? "").toLowerCase()];
      return month === undefined ? null : monthDay(today, month, Number(m[1]));
    },
  },
  { pattern: /\bday after tomorrow\b/i, resolve: (_m, today) => addDays(today, 2) },
  { pattern: /\btomorrow\b/i, resolve: (_m, today) => addDays(today, 1) },
  { pattern: /\b(?:today|tonight)\b/i, resolve: (_m, today) => today },
  {
    pattern:
      /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)\b/i,
    resolve: (m, today) => weekdayInWeek(today, EN_WEEKDAY[(m[1] ?? "").toLowerCase()] ?? 0, 1),
  },
  {
    pattern:
      /\b(?:this|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)\b/i,
    resolve: (m, today) => nextWeekday(today, EN_WEEKDAY[(m[1] ?? "").toLowerCase()] ?? 0),
  },
  {
    pattern: /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
    resolve: (m, today) => nextWeekday(today, EN_WEEKDAY[(m[1] ?? "").toLowerCase()] ?? 0),
  },
];

/**
 * 这个短语的上下文是否表明它是「计划在某时」——「周五前」「before Friday」「by Friday」是截止语义，
 * 不是计划，不应该被悄悄解析成计划日期，保持为普通文本。
 *
 * @param text 原文。
 * @param start 短语起点。
 * @param end 短语终点。
 * @returns 可以解析时为 `true`。
 */
function isQualified(text: string, start: number, end: number): boolean {
  if (/^(?:之前|以前|前|之后|以后|后)/.test(text.slice(end))) return false;
  return !/\b(?:before|after|until|till|by)\s*$/i.test(text.slice(0, start));
}

/**
 * 找出文本里的第一个日期短语。
 *
 * @param text 标题文本。
 * @param today 今天。
 * @returns 日期短语；没有或日期不存在时为 `null`。
 */
function findDate(text: string, today: Date): Token<Date> | null {
  let best: Token<Date> | null = null;
  for (const { pattern, resolve } of [...ZH_DATE_PATTERNS, ...EN_DATE_PATTERNS]) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const value = resolve(match, today);
    if (value === null) continue;
    const token = { start: match.index, end: match.index + match[0].length, value };
    if (!isQualified(text, token.start, token.end)) continue;
    // 取最靠前的；同一位置取更长的（「下周一」优先于「周一」）。
    if (
      best === null ||
      token.start < best.start ||
      (token.start === best.start && token.end > best.end)
    ) {
      best = token;
    }
  }
  return best;
}

/**
 * 把「时段 + 小时」换算成 24 小时制的小时数；歧义（如没有时段的 1–6 点）返回 `null`。
 *
 * @param period 时段词（凌晨 / 早上 / 上午 / 中午 / 下午 / 傍晚 / 晚上），可为空。
 * @param hour 写出来的小时。
 * @returns 24 小时制的小时（0..23）；无法确定时为 `null`。
 */
function resolveHour(period: string | undefined, hour: number): number | null {
  if (hour > 23) return null;
  switch (period) {
    case "凌晨":
      return hour === 12 ? 0 : hour <= 5 ? hour : null;
    case "早上":
    case "早晨":
    case "上午":
      return hour >= 1 && hour <= 12 ? (hour === 12 ? 12 : hour) : null;
    case "中午":
      return hour === 12 || hour === 11 ? hour : hour >= 1 && hour <= 2 ? hour + 12 : null;
    case "下午":
    case "傍晚":
      return hour >= 1 && hour <= 11 ? hour + 12 : hour === 12 ? 12 : null;
    case "晚上":
    case "夜里":
      return hour >= 1 && hour <= 11 ? hour + 12 : null;
    default:
      // 没有时段：13–23 点是 24 小时制；7–12 点按上午理解；0 点是零点；1–6 点有歧义，不解析。
      if (hour >= 13) return hour;
      if (hour === 0) return 0;
      return hour >= 7 && hour <= 12 ? hour : null;
  }
}

/**
 * 格式化时间为 `HH:MM`。
 *
 * @param hour 小时。
 * @param minute 分钟。
 * @returns 文本。
 */
function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * 找出文本里的第一个时间短语。
 *
 * @param text 标题文本。
 * @returns 时间短语（`HH:MM`）；没有或有歧义时为 `null`。
 */
function findTime(text: string): Token<string> | null {
  const candidates: Array<Token<string>> = [];

  // 中文：下午3点 / 下午3点半 / 下午3点30分 / 下午3:30 / 15点 / 15:30。
  const zh =
    /(?:(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)\s*)?(\d{1,2})\s*(?:点钟?|时|[:：])\s*(半|\d{1,2}\s*分?)?/g;
  for (const match of text.matchAll(zh)) {
    const hasColon = /[:：]/.test(match[0]);
    const minutePart = match[3];
    // 冒号写法的分钟必须是两位数字，避免把「16:9」之类的比例当成时间。
    if (
      hasColon &&
      (minutePart === undefined || !/^\d{2}$/.test(minutePart.replace(/\s*分?$/, "")))
    ) {
      continue;
    }
    const minute =
      minutePart === undefined
        ? 0
        : minutePart === "半"
          ? 30
          : Number(minutePart.replace(/\D/g, ""));
    // 冒号写法按 24 小时制理解（9:30 就是 09:30）。
    const hour =
      hasColon && match[1] === undefined
        ? Number(match[2])
        : resolveHour(match[1], Number(match[2]));
    if (hour === null || hour > 23 || minute > 59) continue;
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      value: hhmm(hour, minute),
    });
  }

  // 英文：3pm / 3:30 pm / 3 p.m.
  const meridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi;
  for (const match of text.matchAll(meridiem)) {
    const hour12 = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    if (hour12 < 1 || hour12 > 12 || minute > 59) continue;
    const pm = (match[3] ?? "").toLowerCase().startsWith("p");
    const hour = (hour12 % 12) + (pm ? 12 : 0);
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      value: hhmm(hour, minute),
    });
  }

  // 英文 / 通用的 24 小时制：9:30、15:00（分钟必须是两位）。
  const colon = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;
  for (const match of text.matchAll(colon)) {
    const start = match.index;
    // 已经被中文 / meridiem 规则覆盖的区间不重复。
    if (candidates.some((c) => start >= c.start && start < c.end)) continue;
    candidates.push({
      start,
      end: start + match[0].length,
      value: hhmm(Number(match[1]), Number(match[2])),
    });
  }

  // 同一个起点取更长的（「3:30 pm」比「3:30」完整）。
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  return candidates.find((c) => isQualified(text, c.start, c.end)) ?? null;
}

/**
 * 把一个短语区间向外扩展，带上紧挨着它的连接词：前面的「在 / 于 / on / at / by / for / from」，
 * 后面的「的」（「今天的会议」去掉「今天」后不该留下孤零零的「的会议」）。
 *
 * 只扩展**紧挨着**的连接词，所以标题里别处的「在家办公」不会被误伤。
 *
 * @param text 原文。
 * @param span 短语区间。
 * @returns 扩展后的区间。
 */
function extend(text: string, span: readonly [number, number]): readonly [number, number] {
  let [start, end] = span;
  const before = text.slice(0, start);
  const lead = /(?:(?:^|\s)(?:on|at|for|from)\s*|[在于]\s*|@\s*)$/i.exec(before);
  if (lead !== null) start -= lead[0].length;
  if (text[end] === "的") end += 1;
  return [start, end];
}

/**
 * 清理去掉短语之后的标题：折叠空白，去掉两端的标点。
 *
 * @param raw 去掉短语之后的文本。
 * @returns 整理后的标题。
 */
function tidy(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[\s,，、;；:：\-–—]+/, "")
    .replace(/[\s,，、;；:：\-–—]+$/, "")
    .trim();
}

/**
 * 面向用户的说明：「今天 · 10月14日 周三」「明天 · 10月15日 周四 15:00」「周五 · 10月16日 …」。
 *
 * @param date 日期。
 * @param time 时间。
 * @param today 今天。
 * @returns 说明文字。
 */
function describe(date: Date, time: string | null, today: Date): string {
  const days = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  const relativeKey =
    days === 0 ? "today" : days === 1 ? "tomorrow" : days === 2 ? "dayAfter" : null;
  const relative = relativeKey === null ? null : i18next.t(`quickCreate.relative.${relativeKey}`);
  const absolute = formatDate(date, "monthDayWeekdayShort");
  const day = relative === null ? absolute : `${relative} · ${absolute}`;
  return time === null ? day : `${day} ${time}`;
}

/**
 * 从标题里识别日期 / 时间短语（实施计划 6.7，产品文档 §6.2「明天 Review PR → 计划到明天」）。
 *
 * * 中文：今天 / 明天 / 后天 / 大后天、周五 / 星期三 / 下周一 / 下下周二 / 本周五、X月X日（也接受「号」）、
 *   完整日期 `2026年10月20日`；时间：下午3点 / 3点半 / 15:30 / 晚上8点；
 * * 英文：today / tomorrow / next Monday / this Friday / on Fri / Oct 2 / 2 Oct / October 2nd, 2027 /
 *   3pm / 3:30 pm / 15:00；
 * * 只有时间没有日期时，计划在今天；
 * * **歧义与不确定的保持为普通文本**：没有时段的 1–6 点、不存在的日期（2 月 30 日）、
 *   去掉短语后标题为空（整句只有「明天」）、比例 `16:9`；
 * * 日期与时间各取第一个，其余留在标题里。
 *
 * @param text 输入框里的原文。
 * @param todayIso 今天（`YYYY-MM-DD`，用户本地日期，取自后端）。
 * @returns 识别结果；没有可靠的日期 / 时间时为 `null`。
 */
export function parseDatePhrase(text: string, todayIso: string): DatePhraseResult | null {
  const today = parseISO(todayIso);
  if (Number.isNaN(today.getTime())) return null;
  const date = findDate(text, today);
  const time = findTime(text);
  if (date === null && time === null) return null;

  const spans: Array<readonly [number, number]> = [];
  if (date !== null) spans.push([date.start, date.end]);
  if (time !== null) spans.push([time.start, time.end]);
  // 日期与时间重叠（比如被同一个正则吃掉）时只保留日期区间。
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<readonly [number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] < last[1]) continue;
    merged.push(span);
  }

  let rest = text;
  const removals = merged.map((span) => extend(text, span));
  for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) {
    rest = `${rest.slice(0, start)} ${rest.slice(end)}`;
  }
  const title = tidy(rest);
  if (title === "") return null;

  const schedule: ParsedSchedule = {
    date: iso(date?.value ?? today),
    time: time?.value ?? null,
  };
  const last = merged[merged.length - 1];
  return {
    schedule,
    title,
    label: describe(date?.value ?? today, schedule.time, today),
    spans: merged,
    endsAtTail: last !== undefined && text.slice(last[1]).trim() === "",
  };
}
