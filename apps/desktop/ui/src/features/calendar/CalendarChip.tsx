import { useDraggable } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { useOpenItem } from "@/features/detail";
import { Tooltip } from "@/components";
import { cx } from "@/lib/cx";
import type { CalendarEntryDto, CalendarItemDto } from "@/lib/ipc";

/** 拖拽携带的数据：拖的是哪个条目、从哪天来（待安排的没有日期）。 */
export type DragPayload = {
  /** 被拖动的条目。 */
  item: CalendarItemDto;
  /** 原来所在的日期；`null` 表示来自「待安排」。 */
  fromDate: string | null;
};

/**
 * 条目前面的小标记：待办是勾选框形状，笔记是文档，提示是 💡（计划 4.2）。
 *
 * @param props 条目。
 * @returns 标记元素。
 */
function Marker({ item }: { item: CalendarItemDto }) {
  const done = item.status === "done";
  if (item.itemType === "tip") {
    return (
      <span aria-hidden="true" className="shrink-0 text-[11px] leading-none">
        {"💡"}
      </span>
    );
  }
  if (item.itemType === "note") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-3 shrink-0 text-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      >
        <path d="M4 2.5h6l2.5 2.5v8a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5z" />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cx(
        "flex size-3 shrink-0 items-center justify-center rounded-[3px] border",
        done ? "border-primary bg-primary text-primary-contrast" : "border-muted",
      )}
    >
      {done && (
        <svg
          viewBox="0 0 16 16"
          className="size-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      )}
    </span>
  );
}

/** [`CalendarChip`] 的 Props。 */
export type CalendarChipProps = {
  /** 条目所在日期的条目；待安排的传 `null`。 */
  entry: CalendarEntryDto | null;
  /** 待安排列表里的条目（没有日期）。 */
  loose?: CalendarItemDto;
  /** 是否显示时间前缀（周视图）。 */
  showTime?: boolean;
  /**
   * 月视图的紧凑尺寸：单行 24px 高、更窄的内边距；标签窄于 8rem 时只用旗标与虚线框表示截止，
   * 「截止」文字留在无障碍名称与提示里，把宽度让给标题。
   */
  compact?: boolean;
};

/**
 * Calendar 里的一个条目标签：可拖到别的日期格上重新安排；点击在右侧打开详情。
 *
 * 截止标记（Deadline Overlay）与计划条目外观明确不同：虚线框 + 旗标 + 「截止」，且不可拖动
 * （截止日期不是「打算哪天做」，改它请在详情里改）。已完成的条目划线变淡。
 *
 * @param props 条目与显示选项。
 * @returns 标签元素。
 */
export function CalendarChip({
  entry,
  loose,
  showTime = false,
  compact = false,
}: CalendarChipProps) {
  const { t } = useTranslation();
  const openItem = useOpenItem();
  const item = entry?.item ?? loose;
  const isDue = entry?.kind === "due";
  const done = item?.status === "done";
  const payload: DragPayload | null =
    item === undefined || isDue ? null : { item, fromDate: entry?.date ?? null };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id:
      item === undefined
        ? "none"
        : `${isDue ? "due" : "item"}:${item.id}:${entry?.date ?? "loose"}`,
    data: { ...payload },
    disabled: payload === null,
  });
  if (item === undefined) return null;
  const time = isDue ? item.due?.time : item.scheduled?.time;
  const action = t(
    isDue
      ? "calendar.editDue"
      : item.scheduled === null
        ? "calendar.planItem"
        : "calendar.changePlan",
  );

  return (
    <Tooltip
      content={`${isDue ? t("calendar.dueChip", { title: item.title }) : item.title} · ${action}`}
    >
      <button
        ref={setNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        onKeyDown={(event) => {
          // Enter 始终打开详情；空格保留既有的键盘拖拽入口。
          if (event.key !== "Enter") listeners?.onKeyDown?.(event);
        }}
        onClick={() => openItem?.(item.id)}
        aria-label={isDue ? t("calendar.dueChip", { title: item.title }) : item.title}
        aria-description={action}
        className={cx(
          "flex w-full min-w-0 shrink-0 items-center rounded-md text-left text-xs",
          compact ? "@container h-6 gap-1 px-1" : "min-h-7 flex-wrap gap-1.5 px-1.5 py-1",
          "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
          isDue
            ? "border border-dashed border-danger/60 bg-danger/5 text-danger hover:bg-danger/10"
            : "bg-primary/10 text-text hover:bg-primary/20",
          done && !isDue && "bg-surface-hover text-muted",
          isDragging && "opacity-40",
          payload !== null && "cursor-grab active:cursor-grabbing",
        )}
      >
        {isDue ? (
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-3 shrink-0"
            fill="currentColor"
          >
            <path d="M3.5 2v12M3.5 3h8l-2 2.5 2 2.5h-8z" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        ) : (
          <Marker item={item} />
        )}
        {showTime && time !== undefined && time !== null && (
          <span className="shrink-0 tabular-nums text-muted">{time.slice(0, 5)}</span>
        )}
        <span
          className={cx(
            "min-w-0 flex-1",
            showTime || loose ? "wrap-anywhere whitespace-normal" : "truncate",
            done && !isDue && "line-through",
          )}
        >
          {item.title}
        </span>
        {isDue && (
          <span className={cx("shrink-0 text-xs", compact && "hidden @[8rem]:inline")}>
            {t("calendar.due")}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
