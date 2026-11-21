import { describe, expect, it } from "vitest";
import { parseDatePhrase } from "./date-phrase";

/** 「今天」：2026-10-14，周三。本月：周一 12、周二 13、周三 14、周四 15、周五 16、周六 17、周日 18、周一 19。 */
const TODAY = "2026-10-14";

/** 一条用例：输入 → 期望的标题、日期、时间；`null` 表示不应该被解析（保持普通文本）。 */
type Case = [input: string, expected: { title: string; date: string; time?: string } | null];

/** 表驱动用例（实施计划 6.7：≥ 50 条，含歧义与不应解析的）。 */
const CASES: Case[] = [
  // —— 中文：相对日 ——
  ["明天 Review PR", { title: "Review PR", date: "2026-10-15" }],
  ["Review PR 明天", { title: "Review PR", date: "2026-10-15" }],
  ["今天交周报", { title: "交周报", date: "2026-10-14" }],
  ["后天 去机场", { title: "去机场", date: "2026-10-16" }],
  ["大后天 体检", { title: "体检", date: "2026-10-17" }],
  ["明日 开会", { title: "开会", date: "2026-10-15" }],
  ["今天的会议", { title: "会议", date: "2026-10-14" }],
  ["明天，写周报", { title: "写周报", date: "2026-10-15" }],
  ["在家办公 明天", { title: "在家办公", date: "2026-10-15" }],
  ["明天 后天 xxx", { title: "后天 xxx", date: "2026-10-15" }],
  // —— 中文：星期 ——
  ["周五 提交报告", { title: "提交报告", date: "2026-10-16" }],
  ["提交报告 周五", { title: "提交报告", date: "2026-10-16" }],
  ["星期三 开会", { title: "开会", date: "2026-10-14" }],
  ["礼拜日 休息", { title: "休息", date: "2026-10-18" }],
  ["周一 站会", { title: "站会", date: "2026-10-19" }],
  ["下周一 站会", { title: "站会", date: "2026-10-19" }],
  ["下周五 发布", { title: "发布", date: "2026-10-23" }],
  ["下周日 家庭聚餐", { title: "家庭聚餐", date: "2026-10-25" }],
  ["下下周一 复盘", { title: "复盘", date: "2026-10-26" }],
  ["本周五 交付", { title: "交付", date: "2026-10-16" }],
  ["这周日 爬山", { title: "爬山", date: "2026-10-18" }],
  ["下个周二 面试", { title: "面试", date: "2026-10-20" }],
  // —— 中文：月日与完整日期 ——
  ["10月20日 体检", { title: "体检", date: "2026-10-20" }],
  ["体检 10月20号", { title: "体检", date: "2026-10-20" }],
  ["3月5日 交税", { title: "交税", date: "2027-03-05" }],
  ["2026年12月1日 发布", { title: "发布", date: "2026-12-01" }],
  // —— 中文：时间 ——
  ["下午3点开会", { title: "开会", date: "2026-10-14", time: "15:00" }],
  ["明天下午3点半 开会", { title: "开会", date: "2026-10-15", time: "15:30" }],
  ["明天 15:30 开会", { title: "开会", date: "2026-10-15", time: "15:30" }],
  ["晚上8点 看球", { title: "看球", date: "2026-10-14", time: "20:00" }],
  ["上午9点30分 晨会", { title: "晨会", date: "2026-10-14", time: "09:30" }],
  ["中午12点 午饭", { title: "午饭", date: "2026-10-14", time: "12:00" }],
  ["凌晨2点 发布", { title: "发布", date: "2026-10-14", time: "02:00" }],
  ["早上7点 跑步", { title: "跑步", date: "2026-10-14", time: "07:00" }],
  ["15点 开会", { title: "开会", date: "2026-10-14", time: "15:00" }],
  ["9点 开会", { title: "开会", date: "2026-10-14", time: "09:00" }],
  ["10:30 站会", { title: "站会", date: "2026-10-14", time: "10:30" }],
  ["周五 下午3点 开会", { title: "开会", date: "2026-10-16", time: "15:00" }],
  ["开会 周五下午3点", { title: "开会", date: "2026-10-16", time: "15:00" }],
  // —— 英文 ——
  ["Review PR tomorrow", { title: "Review PR", date: "2026-10-15" }],
  ["tomorrow Review PR", { title: "Review PR", date: "2026-10-15" }],
  ["call mom today", { title: "call mom", date: "2026-10-14" }],
  ["meeting on Friday", { title: "meeting", date: "2026-10-16" }],
  ["meeting next Monday", { title: "meeting", date: "2026-10-19" }],
  ["meeting this Friday", { title: "meeting", date: "2026-10-16" }],
  ["pay rent Oct 20", { title: "pay rent", date: "2026-10-20" }],
  ["pay rent October 20th", { title: "pay rent", date: "2026-10-20" }],
  ["pay rent 20 Oct", { title: "pay rent", date: "2026-10-20" }],
  ["pay rent Oct 2", { title: "pay rent", date: "2027-10-02" }],
  ["conference Oct 2, 2027", { title: "conference", date: "2027-10-02" }],
  ["lunch 2026-10-21", { title: "lunch", date: "2026-10-21" }],
  ["day after tomorrow dentist", { title: "dentist", date: "2026-10-16" }],
  ["standup 3pm", { title: "standup", date: "2026-10-14", time: "15:00" }],
  ["standup tomorrow at 9:30am", { title: "standup", date: "2026-10-15", time: "09:30" }],
  ["dentist 3:30 pm tomorrow", { title: "dentist", date: "2026-10-15", time: "15:30" }],
  ["call at 15:00", { title: "call", date: "2026-10-14", time: "15:00" }],
  ["lunch at 12pm", { title: "lunch", date: "2026-10-14", time: "12:00" }],
  ["reset 12am", { title: "reset", date: "2026-10-14", time: "00:00" }],
  // —— 歧义与不应解析的：保持普通文本 ——
  ["明天", null],
  ["下午5点", null],
  ["2月30日 搬家", null],
  ["3点 开会", null],
  ["3点半 休息", null],
  ["晚上12点 xx", null],
  ["下午13点 xx", null],
  ["16:9 比例的图", null],
  ["版本 2.1.3 发布", null],
  ["给3号电池充电", null],
  ["买 2 杯咖啡", null],
  ["周五前交报告", null],
  ["before Friday submit", null],
  ["due by Friday", null],
  ["整理 2025年10月1日 的文件", null],
  ["13pm foo", null],
  ["may I help", null],
  ["sat on the fence", null],
  ["on the mat", null],
  ["", null],
];

describe("parseDatePhrase（今天 = 2026-10-14 周三）", () => {
  it("表驱动用例至少 50 条", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50);
  });

  it.each(CASES)("%s", (input, expected) => {
    const result = parseDatePhrase(input, TODAY);
    if (expected === null) {
      expect(result).toBeNull();
      return;
    }
    expect(result).not.toBeNull();
    expect(result?.title).toBe(expected.title);
    expect(result?.schedule).toEqual({ date: expected.date, time: expected.time ?? null });
  });

  it("说明文字：相对日带「今天 / 明天 / 后天」，其余带星期与日期", () => {
    expect(parseDatePhrase("明天下午3点 开会", TODAY)?.label).toBe("明天 · 10月15日 周四 15:00");
    expect(parseDatePhrase("今天 开会", TODAY)?.label).toBe("今天 · 10月14日 周三");
    expect(parseDatePhrase("后天 开会", TODAY)?.label).toBe("后天 · 10月16日 周五");
    expect(parseDatePhrase("下周一 开会", TODAY)?.label).toBe("10月19日 周一");
    expect(parseDatePhrase("下午3点 开会", TODAY)?.label).toBe("今天 · 10月14日 周三 15:00");
  });

  it("记录短语位置，并判断最后一个短语是否在文本末尾", () => {
    const tail = parseDatePhrase("Review PR 明天", TODAY);
    expect(tail?.spans).toEqual([[10, 12]]);
    expect(tail?.endsAtTail).toBe(true);
    expect(parseDatePhrase("明天 Review PR", TODAY)?.endsAtTail).toBe(false);
    expect(parseDatePhrase("开会 周五下午3点 ", TODAY)?.endsAtTail).toBe(true);
  });

  it("今天不合法时不解析", () => {
    expect(parseDatePhrase("明天 开会", "不是日期")).toBeNull();
  });

  it("跨年与月末：明天 / 下周一", () => {
    expect(parseDatePhrase("明天 开会", "2026-12-31")?.schedule.date).toBe("2027-01-01");
    expect(parseDatePhrase("明天 开会", "2028-02-28")?.schedule.date).toBe("2028-02-29");
    expect(parseDatePhrase("下周一 开会", "2026-12-30")?.schedule.date).toBe("2027-01-04");
    // 周日说「下周一」是第二天。
    expect(parseDatePhrase("下周一 开会", "2026-10-18")?.schedule.date).toBe("2026-10-19");
  });
});
