import type {
  ContentFormatDto,
  DatePointDto,
  ItemDto,
  ItemTypeDto,
  PriorityDto,
  UpdateItemRequest,
} from "@/lib/ipc";

/**
 * 详情面板里正在编辑的字段（表单形态）。
 *
 * 日期与时间是分开的输入框，所以分成两个字符串；空串表示「没有」。
 * 这里只负责「表单 ↔ 请求」的转换与差异计算，业务规则（哪些字段适用于哪种类型、
 * 标题是否合法）全部在后端，前端不复制（前端规范 §1）。
 */
export type ItemDraft = {
  /** 类型。 */
  itemType: ItemTypeDto;
  /** 标题。 */
  title: string;
  /** 内容（描述）；空串表示没有。 */
  content: string;
  /** 内容格式。 */
  contentFormat: ContentFormatDto;
  /** 优先级。 */
  priority: PriorityDto;
  /** 计划日期 `YYYY-MM-DD`；空串表示没有。 */
  scheduledDate: string;
  /** 计划时间 `HH:MM`；空串表示全天。 */
  scheduledTime: string;
  /** 截止日期 `YYYY-MM-DD`；空串表示没有。 */
  dueDate: string;
  /** 截止时间 `HH:MM`；空串表示全天。 */
  dueTime: string;
  /** 所属项目 ID；空串表示没有项目。 */
  projectId: string;
};

/**
 * 把后端的日期点拆成表单的两个字段。
 *
 * @param point 日期点；`null` 表示没有。
 * @returns 日期与时间（`HH:MM`），没有时为空串。
 */
function splitPoint(point: DatePointDto | null): { date: string; time: string } {
  return { date: point?.date ?? "", time: point?.time?.slice(0, 5) ?? "" };
}

/**
 * 由后端的 Item 得到表单的初始值。
 *
 * @param item 后端返回的 Item。
 * @returns 表单草稿。
 */
export function toDraft(item: ItemDto): ItemDraft {
  const scheduled = splitPoint(item.scheduled);
  const due = splitPoint(item.due);
  return {
    itemType: item.itemType,
    title: item.title,
    content: item.content ?? "",
    contentFormat: item.contentFormat,
    priority: item.priority,
    scheduledDate: scheduled.date,
    scheduledTime: scheduled.time,
    dueDate: due.date,
    dueTime: due.time,
    projectId: item.projectId ?? "",
  };
}

/**
 * 日期与时间 → 对日期点的三态修改。
 *
 * @param before 原来的日期与时间。
 * @param date 现在的日期。
 * @param time 现在的时间。
 * @returns 没有变化返回 `undefined`；日期被清空返回「清除」；否则返回「设置」。
 */
function pointPatch(
  before: { date: string; time: string },
  date: string,
  time: string,
): { kind: "clear" } | { kind: "set"; value: DatePointDto } | undefined {
  if (before.date === date && before.time === time) return undefined;
  if (date === "") return before.date === "" ? undefined : { kind: "clear" };
  return { kind: "set", value: { date, time: time === "" ? null : time } };
}

/**
 * 计算草稿相对于后端 Item 的修改：只包含真正变化的字段（没有变化返回 `null`）。
 *
 * 清空内容 / 日期会得到「清除」，而不是空串，所以 `null` 与「不修改」不会混淆。
 *
 * @param item 后端当前的 Item。
 * @param draft 表单草稿。
 * @returns 要发送的修改；没有任何变化时为 `null`。
 */
export function buildPatch(item: ItemDto, draft: ItemDraft): UpdateItemRequest | null {
  const before = toDraft(item);
  const patch: UpdateItemRequest = {};
  if (draft.itemType !== before.itemType) patch.itemType = draft.itemType;
  if (draft.title !== before.title) patch.title = draft.title;
  if (draft.content !== before.content) {
    patch.content =
      draft.content.trim() === "" ? { kind: "clear" } : { kind: "set", value: draft.content };
  }
  if (draft.contentFormat !== before.contentFormat) patch.contentFormat = draft.contentFormat;
  if (draft.priority !== before.priority) patch.priority = draft.priority;
  const scheduled = pointPatch(
    { date: before.scheduledDate, time: before.scheduledTime },
    draft.scheduledDate,
    draft.scheduledTime,
  );
  if (scheduled !== undefined) patch.scheduled = scheduled;
  const due = pointPatch(
    { date: before.dueDate, time: before.dueTime },
    draft.dueDate,
    draft.dueTime,
  );
  if (due !== undefined) patch.due = due;
  if (draft.projectId !== before.projectId) {
    patch.projectId =
      draft.projectId === "" ? { kind: "clear" } : { kind: "set", value: draft.projectId };
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * 保存成功之后，从「尚未保存的修改」里去掉已经保存的字段。
 *
 * 保存期间用户可能又改了别的字段（或同一字段又改了一次）：只有仍然等于「发出去的值」的字段
 * 才算保存完成，其余的继续保留，等待下一次保存。
 *
 * @param edits 当前尚未保存的字段。
 * @param sent 保存开始时发出去的完整草稿。
 * @returns 剩余尚未保存的字段。
 */
export function dropSaved(edits: Partial<ItemDraft>, sent: ItemDraft): Partial<ItemDraft> {
  const remaining: Partial<ItemDraft> = {};
  for (const key of Object.keys(edits) as (keyof ItemDraft)[]) {
    if (edits[key] !== sent[key]) Object.assign(remaining, { [key]: edits[key] });
  }
  return remaining;
}
