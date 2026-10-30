import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import { parseISO } from "date-fns";
import { formatDate } from "@/lib/date-format";
import { isTyping } from "@/lib/typing";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { parseDatePhrase } from "@/features/quick-create";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import type { CalendarEntryDto, CalendarItemDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";
import { CalendarChip } from "./CalendarChip";
import type { DragPayload } from "./CalendarChip";
import {
  buildWeeks,
  dayLabel,
  groupByDate,
  shiftAnchor,
  titleFor,
  toIsoDate,
  weekdayLabels,
} from "./model/calendar-grid";
import type { CalendarViewKind } from "./model/calendar-grid";

/**
 * 在某一天里写的时间（「下午3点 开会」「15:00 评审」）就是那天的时间；日期由格子决定，
 * 所以只认只有时间的短语（以这一格为「今天」解析，日期仍是这一天的才算）。
 *
 * @param title 输入的文字。
 * @param date 格子的日期。
 * @returns 去掉时间短语之后的标题与 `HH:MM`；没有认出时间时为 `null`。
 */
function timeInDay(title: string, date: string): { title: string; time: string } | null {
  const parsed = parseDatePhrase(title, date);
  if (parsed === null || parsed.schedule.date !== date || parsed.schedule.time === null)
    return null;
  return { title: parsed.title, time: parsed.schedule.time.slice(0, 5) };
}

/** 月视图每个格子最多直接显示几个条目，其余折叠成「还有 N 项」。 */
const MONTH_CELL_LIMIT = 3;

/** 拖动超过这个距离（px）才算开始拖拽，避免点击被误判成拖拽。 */
const DRAG_ACTIVATION_DISTANCE_PX = 5;

/** 容器至少这么宽（px）时默认显示「待安排」侧栏，更窄时默认收起，给日期格让出空间。 */
const WIDE_LAYOUT_PX = 1000;

/**
 * 监听元素的宽度；没有 `ResizeObserver`（如测试环境）时返回 `null`。
 *
 * @param ref 要监听的元素。
 * @returns 当前宽度（px），或 `null`。
 */
function useElementWidth(ref: React.RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** 撤销提示停留的时间（毫秒）。 */
const UNDO_MS = 6000;

/** [`DayCell`] 的 Props。 */
type DayCellProps = {
  /** 这一格的日期（`YYYY-MM-DD`）。 */
  date: string;
  /** 当前视图的锚点（月视图里用来淡化不属于本月的日期）。 */
  anchor: string;
  /** 今天。 */
  today: string;
  /** 视图。 */
  view: CalendarViewKind;
  /** 这一天的条目。 */
  entries: CalendarEntryDto[];
  /** 是否正在这一格里添加待办。 */
  adding: boolean;
  /** 开始 / 结束添加。 */
  onAdd: (adding: boolean) => void;
  /** 提交新待办的标题。 */
  onCreate: (date: string, title: string) => void;
  /** 展开这一天（切到周视图）。 */
  onExpand: (date: string) => void;
};

/**
 * 日历里的一天：日期数字、条目标签、悬停出现的「+」（点击后原地写下一条待办）。
 *
 * 也是拖拽的落点：拖到这一格上会高亮，放下就把条目安排到这一天。
 *
 * @param props 日期、条目与回调。
 * @returns 一格。
 */
function DayCell({
  date,
  anchor,
  today,
  view,
  entries,
  adding,
  onAdd,
  onCreate,
  onExpand,
}: DayCellProps) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: date });
  const [title, setTitle] = useState("");
  const parsed = parseISO(date);
  const isToday = date === today;
  const outside = view === "month" && parsed.getMonth() !== parseISO(anchor).getMonth();
  const weekend = parsed.getDay() === 0 || parsed.getDay() === 6;
  const visible = view === "month" ? entries.slice(0, MONTH_CELL_LIMIT) : entries;
  const hidden = entries.length - visible.length;
  /** 输入里认出的时间：在格子里给个小提示，回车后就是这一天的这个时间。 */
  const recognised = adding ? timeInDay(title, date) : null;

  /**
   * 回车创建，Esc / 失焦取消。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      if (title.trim() !== "") onCreate(date, title);
      setTitle("");
      onAdd(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setTitle("");
      onAdd(false);
    }
  }

  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      aria-label={formatDate(parsed, "monthDayWeekday")}
      aria-current={isToday ? "date" : undefined}
      className={cx(
        "group relative flex min-h-0 min-w-0 flex-col gap-1 border-r border-b border-border p-1.5",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        weekend && !outside && "bg-surface-hover/40",
        outside && "bg-bg text-muted",
        isOver && "bg-primary/10 outline-2 -outline-offset-2 outline-primary",
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cx(
            "flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs whitespace-nowrap tabular-nums",
            isToday
              ? "bg-primary font-semibold text-primary-contrast"
              : outside
                ? "text-muted"
                : "text-text",
          )}
        >
          {dayLabel(date)}
        </span>
        <button
          type="button"
          aria-label={t("calendar.addOn", { date: formatDate(parsed, "monthDay") })}
          onClick={() => onAdd(true)}
          className="flex size-5 items-center justify-center rounded text-muted opacity-0 transition-opacity duration-(--nv-duration-fast) hover:bg-surface-hover hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
        >
          {"+"}
        </button>
      </div>
      <div
        className={cx("flex min-h-0 flex-1 flex-col gap-1", view === "week" && "overflow-y-auto")}
      >
        {visible.map((entry) => (
          <CalendarChip
            key={`${entry.kind}:${entry.item.id}`}
            entry={entry}
            showTime={view === "week"}
          />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => onExpand(date)}
            className="rounded px-1.5 text-left text-[11px] text-muted hover:text-text"
          >
            {t("calendar.more", { count: hidden })}
          </button>
        )}
        {adding && (
          <input
            autoFocus
            aria-label={t("calendar.newTodo")}
            placeholder={t("calendar.newTodoPlaceholder")}
            value={title}
            maxLength={500}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              setTitle("");
              onAdd(false);
            }}
            className="h-7 w-full rounded-md border border-primary bg-surface px-1.5 text-xs text-text placeholder:text-muted focus-visible:outline-none"
          />
        )}
        {adding && recognised !== null && (
          <span role="status" className="px-1 text-[11px] text-primary tabular-nums">
            {t("calendar.timeRecognised", { time: recognised.time })}
          </span>
        )}
      </div>
    </div>
  );
}

/** [`Unscheduled`] 的 Props。 */
type UnscheduledProps = {
  /** 待安排的待办。 */
  items: CalendarItemDto[];
};

/**
 * 右侧的「待安排」列表：还没有日期的待办，可以直接拖到日期格上。
 *
 * @param props 待办。
 * @returns 侧栏。
 */
function Unscheduled({ items }: UnscheduledProps) {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t("calendar.unscheduled")}
      className="flex w-60 shrink-0 flex-col border-l border-border bg-surface"
    >
      <header className="flex items-baseline justify-between px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-text">{t("calendar.unscheduled")}</h2>
        <span className="text-xs text-muted tabular-nums">{items.length}</span>
      </header>
      <p className="px-4 pb-2 text-xs text-muted">{t("calendar.unscheduledHint")}</p>
      {items.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted">{t("calendar.unscheduledEmpty")}</p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
          {items.map((item) => (
            <li key={item.id}>
              <CalendarChip entry={null} loose={item} />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * Calendar 视图（实施计划 4.2、4.3）：月 / 周两种视图，计划条目与截止标记明确区分，
 * 把条目拖到某一天就重新安排，带撤销。
 *
 * * 工具栏：上一页 / 今天 / 下一页、月 / 周切换；一周从周几开始由设置决定；
 * * 格子里：日期数字（今天高亮）、条目标签、悬停出现的「+」可以原地写下一条待办；
 * * 月视图每格最多 3 条，其余折叠成「还有 N 项」，点击切到周视图；
 * * 拖拽：从「待安排」或另一天拖到日期格上，保留原有的具体时间；成功后给出「撤销」。
 *
 * @returns Calendar 页面。
 */
export function CalendarPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<CalendarViewKind>("month");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  /** 用户手动展开 / 收起「待安排」；`null` 表示跟随宽度。 */
  const [sideOpen, setSideOpen] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const width = useElementWidth(rootRef);

  // 第一次取数时用「今天」作为锚点：今天由后端按用户时区给出，前端不自己读系统时间。
  const initial = useQuery({
    queryKey: queryKeys.calendar("initial", ""),
    queryFn: () => ipc.getCalendar({ view: "week", anchor: toIsoDate(new Date()) }),
    staleTime: Infinity,
    enabled: anchor === null,
  });
  const effectiveAnchor = anchor ?? initial.data?.today ?? null;
  const calendar = useQuery({
    queryKey: queryKeys.calendar(view, effectiveAnchor ?? ""),
    queryFn: () => ipc.getCalendar({ view, anchor: effectiveAnchor ?? "" }),
    enabled: effectiveAnchor !== null,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  });
  const data = calendar.data;

  const today = calendar.data?.today ?? initial.data?.today ?? null;

  // 键盘：J / K 下一段 / 上一段，T 回到今天，M / W 切换月 / 周视图（常见日历应用的约定）。
  // 正在输入、按着修饰键或有对话框打开时不响应。
  useEffect(() => {
    /**
     * 页面快捷键。
     *
     * @param event 键盘事件。
     */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event) || document.querySelector('[aria-modal="true"]') !== null) return;
      if (effectiveAnchor === null) return;
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") {
        setAnchor(shiftAnchor(view, effectiveAnchor, key === "j" ? 1 : -1));
      } else if (key === "t" && today !== null) {
        setAnchor(today);
      } else if (key === "m" || key === "w") {
        setView(key === "m" ? "month" : "week");
        setAdding(null);
      } else {
        return;
      }
      event.preventDefault();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, effectiveAnchor, today]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX } }),
    useSensor(KeyboardSensor),
  );

  if (data === undefined || effectiveAnchor === null) {
    return <section ref={rootRef} aria-label={t("calendar.label")} className="h-full" />;
  }
  const weeks = buildWeeks(data.from, data.to);
  const groups = groupByDate(data.entries);

  /**
   * 切换视图时保持「在看的那一天」：从周视图回月视图时留在同一个月。
   *
   * @param next 新的视图。
   */
  function switchView(next: CalendarViewKind): void {
    setView(next);
    setAdding(null);
  }

  /**
   * 创建一条计划在某天的待办。
   *
   * @param date 日期。
   * @param title 标题。
   */
  function createTodo(date: string, title: string): void {
    const timed = timeInDay(title, date);
    ipc
      .createItem({
        itemType: "todo",
        title: timed?.title ?? title,
        content: null,
        contentFormat: null,
        priority: null,
        scheduled: { date, time: timed?.time ?? null },
        due: null,
        reminderAt: null,
        projectId: null,
      })
      .catch(reportError);
  }

  /**
   * 把拖动的条目安排到 `date`：保留原有的具体时间；成功后给出可撤销的提示。
   *
   * @param payload 被拖动的条目与来源。
   * @param date 目标日期。
   */
  function schedule(payload: DragPayload, date: string): void {
    if (payload.fromDate === date) return;
    const previous = payload.item.scheduled;
    const time = previous?.time ?? null;
    ipc
      .rescheduleItem(payload.item.id, { kind: "exact", scheduled: { date, time } })
      .then(() => {
        useToastStore.getState().push(
          "success",
          t("calendar.scheduled", {
            title: payload.item.title,
            date: formatDate(parseISO(date), "monthDay"),
          }),
          UNDO_MS,
          {
            label: t("today.undo"),
            onClick: () => {
              ipc
                .rescheduleItem(payload.item.id, { kind: "exact", scheduled: previous })
                .catch(reportError);
            },
          },
        );
      })
      .catch(reportError);
  }

  /**
   * 拖动开始：记下被拖的条目（用于拖动时的浮层）。
   *
   * @param event 拖拽事件。
   */
  function handleDragStart(event: DragStartEvent): void {
    setDragging((event.active.data.current as DragPayload | undefined) ?? null);
  }

  /**
   * 拖动结束：落在日期格上就安排到那天。
   *
   * @param event 拖拽事件。
   */
  function handleDragEnd(event: DragEndEvent): void {
    setDragging(null);
    const payload = event.active.data.current as DragPayload | undefined;
    if (payload !== undefined && event.over !== null) schedule(payload, String(event.over.id));
  }

  const title = titleFor(view, effectiveAnchor, data.from, data.to);
  const showSide = sideOpen ?? (width === null || width >= WIDE_LAYOUT_PX);
  return (
    <section ref={rootRef} aria-label={t("calendar.label")} className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
          <div className="flex items-center gap-2">
            <h1 className="min-w-44 text-lg font-semibold text-text tabular-nums">{title}</h1>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("calendar.previous")}
              onClick={() => setAnchor(shiftAnchor(view, effectiveAnchor, -1))}
            >
              {"‹"}
            </Button>
            <Button size="sm" onClick={() => setAnchor(data.today)}>
              {t("calendar.today")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("calendar.next")}
              onClick={() => setAnchor(shiftAnchor(view, effectiveAnchor, 1))}
            >
              {"›"}
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={showSide}
              onClick={() => setSideOpen(!showSide)}
            >
              {t("calendar.unscheduled")}
              <span className="ml-1 text-muted tabular-nums">{data.unscheduled.length}</span>
            </Button>
            <div
              role="group"
              aria-label={t("calendar.viewSwitch")}
              className="flex rounded-md border border-border bg-bg p-0.5"
            >
              {(["month", "week"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  onClick={() => switchView(option)}
                  className={cx(
                    "h-7 rounded-sm px-3 text-xs transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
                    view === option
                      ? "bg-primary font-medium text-primary-contrast"
                      : "text-muted hover:bg-surface-hover hover:text-text",
                  )}
                >
                  {t(`calendar.view.${option}`)}
                </button>
              ))}
            </div>
          </div>
        </header>
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <div className="flex min-h-0 flex-1">
            <div role="grid" aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div role="row" className="grid grid-cols-7 border-b border-border bg-surface">
                {weekdayLabels(data.from).map((label) => (
                  <div
                    key={label}
                    role="columnheader"
                    className="px-2 py-1.5 text-center text-xs font-medium whitespace-nowrap text-muted"
                  >
                    {label}
                  </div>
                ))}
              </div>
              <div
                className="grid min-h-0 flex-1 border-l border-border"
                style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
              >
                {weeks.map((week) => (
                  <div key={week[0]} role="row" className="grid min-h-0 grid-cols-7">
                    {week.map((date) => (
                      <DayCell
                        key={date}
                        date={date}
                        anchor={effectiveAnchor}
                        today={data.today}
                        view={view}
                        entries={groups.get(date) ?? []}
                        adding={adding === date}
                        onAdd={(on) => setAdding(on ? date : null)}
                        onCreate={createTodo}
                        onExpand={(day) => {
                          setAnchor(day);
                          switchView("week");
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            {showSide && <Unscheduled items={data.unscheduled} />}
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging !== null && (
              <div className="w-48 rotate-1 rounded-md bg-surface px-2 py-1.5 text-xs text-text shadow-lg ring-2 ring-primary">
                <span className="block truncate">{dragging.item.title}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
    </section>
  );
}
