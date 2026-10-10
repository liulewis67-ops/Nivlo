import { describe, expect, it } from "vitest";
import type { ItemDto } from "@/lib/ipc";
import { buildPatch, dropSaved, toDraft } from "./item-draft";

/** 一个完整的 Todo。 */
const TODO: ItemDto = {
  id: "1",
  itemType: "todo",
  title: "写周报",
  content: "要点",
  contentFormat: "plain",
  status: "open",
  priority: "high",
  scheduled: { date: "2026-10-12", time: "09:30:00" },
  due: { date: "2026-10-20", time: null },
  reminderAt: null,
  projectId: null,
  inInbox: false,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  completedAt: null,
  archivedAt: null,
};

describe("toDraft", () => {
  it("把日期点拆成日期与 HH:MM，没有的为空串", () => {
    expect(toDraft(TODO)).toMatchObject({
      scheduledDate: "2026-10-12",
      scheduledTime: "09:30",
      dueDate: "2026-10-20",
      dueTime: "",
      content: "要点",
    });
    expect(toDraft({ ...TODO, content: null, scheduled: null, due: null })).toMatchObject({
      content: "",
      scheduledDate: "",
      dueDate: "",
    });
  });
});

describe("buildPatch", () => {
  it("没有变化时为 null", () => {
    expect(buildPatch(TODO, toDraft(TODO))).toBeNull();
  });

  it("只包含变化的字段", () => {
    const draft = { ...toDraft(TODO), title: "写周报（终稿）", priority: "low" as const };
    expect(buildPatch(TODO, draft)).toEqual({ title: "写周报（终稿）", priority: "low" });
  });

  it("清空内容 / 日期得到「清除」，而不是空串或「不修改」", () => {
    const draft = { ...toDraft(TODO), content: "  ", scheduledDate: "", dueDate: "" };
    expect(buildPatch(TODO, draft)).toEqual({
      content: { kind: "clear" },
      scheduled: { kind: "clear" },
      due: { kind: "clear" },
    });
  });

  it("设置日期与时间；清空时间变成全天", () => {
    const draft = {
      ...toDraft(TODO),
      scheduledDate: "2026-10-13",
      scheduledTime: "",
      dueTime: "18:00",
    };
    expect(buildPatch(TODO, draft)).toEqual({
      scheduled: { kind: "set", value: { date: "2026-10-13", time: null } },
      due: { kind: "set", value: { date: "2026-10-20", time: "18:00" } },
    });
  });

  it("原本没有日期、现在也没有：不产生修改；原本没有、现在设置：产生设置", () => {
    const noDates = { ...TODO, scheduled: null, due: null };
    expect(buildPatch(noDates, toDraft(noDates))).toBeNull();
    expect(buildPatch(noDates, { ...toDraft(noDates), dueDate: "2026-11-01" })).toEqual({
      due: { kind: "set", value: { date: "2026-11-01", time: null } },
    });
  });

  it("类型与内容格式的切换", () => {
    expect(
      buildPatch(TODO, { ...toDraft(TODO), itemType: "note", contentFormat: "markdown" }),
    ).toEqual({ itemType: "note", contentFormat: "markdown" });
  });
});

describe("dropSaved", () => {
  it("已保存的字段被去掉；保存期间又改过的字段保留", () => {
    const sent = { ...toDraft(TODO), title: "新标题", content: "第一版" };
    const edits = { title: "新标题", content: "第一版，又改了一点" };
    expect(dropSaved(edits, sent)).toEqual({ content: "第一版，又改了一点" });
  });

  it("全部保存完成时为空", () => {
    const sent = { ...toDraft(TODO), title: "x" };
    expect(dropSaved({ title: "x" }, sent)).toEqual({});
  });
});
