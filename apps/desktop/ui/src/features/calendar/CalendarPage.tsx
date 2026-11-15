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
import { isCommandKey, isDialogOpen, isTyping } from "@/lib/typing";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { OpenItemContext, useOpenItem } from "@/features/detail";
import { useNavStore } from "@/features/shell";
import { LAYOUT, useContainerWidth } from "@/lib/layout";
import { trapTab } from "@/lib/focus-trap";
import { CreateConfiguration, parseDatePhrase } from "@/features/quick-create";
import { textDraft } from "@/features/capture";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import type { CalendarEntryDto, CalendarItemDto, ItemDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";
import { CalendarChip } from "./CalendarChip";
import type { DragPayload } from "./CalendarChip";
import {
  buildWeeks,
  dayLabel,
  groupByDate,
  monthCellVisibleCount,
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

/** 拖动超过这个距离（px）才算开始拖拽，避免点击被误判成拖拽。 */
const DRAG_ACTIVATION_DISTANCE_PX = 5;

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
  /** 有效宽度不足时，周视图按天纵向排列。 */
  stacked: boolean;
  /** 这一天的条目。 */
  entries: CalendarEntryDto[];
  /** 是否正在这一格里添加待办。 */
  adding: boolean;
  /** 开始 / 结束添加。 */
  onAdd: (adding: boolean) => void;
  /** 提交新待办的标题。 */
  onCreate: (date: string, title: string) => Promise<boolean>;
  /** 在当天打开新增配置，用于导入或预填外部文字。 */
  onConfigure: (date: string, text: string | null) => void;
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
  stacked,
  entries,
  adding,
  onAdd,
  onCreate,
  onConfigure,
  onExpand,
}: DayCellProps) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: date });
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [externalOver, setExternalOver] = useState(false);
  const submitting = useRef(false);
  const cellRef = useRef<HTMLDivElement>(null);
  const [cellHeight, setCellHeight] = useState<number | null>(null);
  useEffect(() => {
    const cell = cellRef.current;
    if (!cell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setCellHeight(cell.getBoundingClientRect().height));
    observer.observe(cell);
    return () => observer.disconnect();
  }, []);
  const parsed = parseISO(date);
  const isToday = date === today;
  const outside = view === "month" && parsed.getMonth() !== parseISO(anchor).getMonth();
  const weekend = parsed.getDay() === 0 || parsed.getDay() === 6;
  // 月视图格子窄而矮（默认窗口约 106×110px），用紧凑尺寸让标题和条目数都尽量放得下。
  const compact = view === "month";
  const visible =
    view === "month"
      ? entries.slice(0, monthCellVisibleCount(entries.length, cellHeight))
      : entries;
  const hidden = entries.length - visible.length;
  /** 输入里认出的时间：在格子里给个小提示，回车后就是这一天的这个时间。 */
  const recognised = adding ? timeInDay(title, date) : null;

  /**
   * 确认创建后才清空；组合输入与重复提交不会创建条目。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (title.trim() === "" || submitting.current) return;
      submitting.current = true;
      setPending(true);
      void onCreate(date, title).then((success) => {
        submitting.current = false;
        setPending(false);
        if (success) {
          setTitle("");
          onAdd(false);
        }
      });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (submitting.current) return;
      setTitle("");
      onAdd(false);
    }
  }

  return (
    <div
      ref={(node) => {
        cellRef.current = node;
        setNodeRef(node);
      }}
      role="gridcell"
      data-calendar-day={date}
      aria-label={formatDate(parsed, "monthDayWeekday")}
      aria-current={isToday ? "date" : undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("text/plain")) return;
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, [contenteditable]")
        )
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setExternalOver(true);
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setExternalOver(false);
      }}
      onDrop={(event) => {
        setExternalOver(false);
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, [contenteditable]")
        )
          return;
        const text = event.dataTransfer.getData("text/plain");
        if (!text.trim()) return;
        event.preventDefault();
        onConfigure(date, text);
      }}
      className={cx(
        "group relative flex min-h-0 min-w-0 flex-col border-r border-b border-border",
        compact ? "gap-0.5 px-1 pt-1 pb-0.5" : "gap-1 p-1.5",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        weekend && !outside && "bg-surface-hover/40",
        outside && "bg-bg text-muted",
        (isOver || externalOver) && "bg-primary/10 outline-2 -outline-offset-2 outline-primary",
        stacked && (entries.length === 0 ? "min-h-16 shrink-0" : "max-h-80 min-h-40 shrink-0"),
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
          {stacked ? formatDate(parsed, "monthDayWeekday") : dayLabel(date)}
        </span>
        <button
          type="button"
          data-day-add=""
          aria-label={t("calendar.addOn", { date: formatDate(parsed, "monthDay") })}
          onClick={() => onAdd(true)}
          className={cx(
            "flex items-center justify-center rounded text-muted hover:bg-surface-hover hover:text-text",
            compact ? "size-6" : "size-7",
          )}
        >
          {"+"}
        </button>
      </div>
      <div
        role="region"
        aria-label={formatDate(parsed, "monthDayWeekday")}
        tabIndex={0}
        className={cx(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          compact ? "gap-0.5" : "gap-1",
        )}
      >
        {visible.map((entry) => (
          <CalendarChip
            key={`${entry.kind}:${entry.item.id}`}
            entry={entry}
            showTime={view === "week"}
            compact={compact}
          />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => onExpand(date)}
            className={cx(
              "shrink-0 rounded text-left text-xs text-muted hover:text-text",
              compact ? "h-6 px-1" : "min-h-7 px-1.5",
            )}
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
            readOnly={pending}
            aria-busy={pending}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={handleKeyDown}
            className="h-7 w-full shrink-0 rounded-md border border-primary bg-surface px-1.5 text-xs text-text placeholder:text-muted focus-visible:outline-none"
          />
        )}
        {adding && recognised !== null && (
          <span role="status" className="px-1 text-xs text-primary tabular-nums">
            {t("calendar.timeRecognised", { time: recognised.time })}
          </span>
        )}
        {adding && title.trim() === "" && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 self-start"
            onClick={() => onConfigure(date, null)}
          >
            {t("calendar.pasteOnDay")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** 日历网格里方向键对应的步长：左右一天，上下一周。 */
const DAY_STEPS: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

/**
 * 网格里的方向键：在各天的「+」之间移动（左右一天、上下一周），到边上就停住；
 * 到了想要的那天按 Enter 就能原地写一条待办。
 *
 * @param event 键盘事件。
 */
function moveBetweenDays(event: KeyboardEvent<HTMLElement>): void {
  const step = DAY_STEPS[event.key];
  const target = event.target;
  if (step === undefined || !(target instanceof HTMLElement) || !target.matches("[data-day-add]")) {
    return;
  }
  const days = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-day-add]")];
  const next = days[days.indexOf(target) + step];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}

/** [`Unscheduled`] 的 Props。 */
type UnscheduledProps = {
  /** 待安排的待办。 */
  items: CalendarItemDto[];
  /** 侧页的关闭操作；停靠时不传。 */
  onClose?: () => void;
};

/**
 * 右侧的「待安排」列表：还没有日期的待办，可以直接拖到日期格上。
 *
 * @param props 待办。
 * @returns 侧栏。
 */
function Unscheduled({ items, onClose }: UnscheduledProps) {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t("calendar.unscheduled")}
      className={cx(
        "flex min-h-0 shrink-0 flex-col border-l border-border bg-surface",
        onClose ? "h-full w-full" : "w-60",
      )}
    >
      <header className="flex items-baseline justify-between px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-text">{t("calendar.unscheduled")}</h2>
        <span className="text-xs text-muted tabular-nums">{items.length}</span>
        {onClose && (
          <Button size="sm" onClick={onClose}>
            {t("calendar.closeBacklog")}
          </Button>
        )}
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
 * 原生模态层使整个应用背景不可交互；打开详情之前先交还焦点所有权。
 *
 * @param props 条目与关闭操作。
 * @returns 待安排侧页。
 */
function BacklogSheet({ items, onClose }: Required<UnscheduledProps>) {
  const { t } = useTranslation();
  const openItem = useOpenItem();
  const ref = useRef<HTMLDialogElement>(null);
  const origin = useRef(document.activeElement);
  useEffect(() => {
    const dialog = ref.current;
    const opener = origin.current;
    dialog?.showModal();
    dialog?.focus();
    return () => {
      dialog?.close();
      if (
        (document.activeElement === document.body || dialog?.contains(document.activeElement)) &&
        opener instanceof HTMLElement &&
        opener.isConnected
      )
        opener.focus();
    };
  }, []);
  useEffect(
    () =>
      useNavStore.subscribe((next, previous) => {
        if (next.detailId !== previous.detailId || next.view !== previous.view) onClose();
      }),
    [onClose],
  );
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-modal="true"
      aria-label={t("calendar.unscheduled")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (isCommandKey(event, "k") || (event.key === "?" && !isTyping(event))) {
          ref.current?.close();
          onClose();
        }
        trapTab(event, ref.current);
      }}
      className="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-[min(384px,calc(100vw-32px))] max-w-none border-0 bg-surface p-0 text-text shadow-lg backdrop:bg-black/30"
    >
      <OpenItemContext
        value={(id) => {
          ref.current?.close();
          if (origin.current instanceof HTMLElement) origin.current.focus();
          onClose();
          openItem?.(id);
        }}
      >
        <Unscheduled items={items} onClose={onClose} />
      </OpenItemContext>
    </dialog>
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
  const openItem = useOpenItem();
  const [view, setView] = useState<CalendarViewKind>("month");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [createDraft, setCreateDraft] = useState<{
    date: string;
    text: string | null;
    opener: HTMLElement | null;
  } | null>(null);
  /** 用户手动展开 / 收起「待安排」；`null` 表示跟随宽度。 */
  const [sideOpen, setSideOpen] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const width = useContainerWidth(rootRef);
  const [announcement, setAnnouncement] = useState("");
  const expandedDay = useRef<string | null>(null);

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

  useEffect(() => {
    if (expandedDay.current === null || view !== "week" || calendar.isPlaceholderData) return;
    const region = rootRef.current?.querySelector<HTMLElement>(
      `[data-calendar-day="${expandedDay.current}"] [role="region"]`,
    );
    if (region) {
      region.focus({ preventScroll: true });
      if (width < LAYOUT.stackedCalendarWeek)
        region.closest('[role="gridcell"]')?.scrollIntoView({ block: "start" });
      expandedDay.current = null;
    }
  }, [view, width, calendar.data, calendar.isPlaceholderData]);

  // 键盘：J / K 下一段 / 上一段，T 回到今天，M / W 切换月 / 周视图（常见日历应用的约定）。
  // 正在输入、按着修饰键或有对话框打开时不响应。
  useEffect(() => {
    /**
     * 页面快捷键。
     *
     * @param event 键盘事件。
     */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      // Ctrl+N：在今天（今天不在这一页时在这一页的锚点日期）原地写一条待办，与其他页的「新建」一致。
      const range = calendar.data;
      // 翻页后新一页还在加载时，网格仍是上一页：先不响应，免得写到看不见的那天。
      if (
        isCommandKey(event, "n") &&
        !isDialogOpen() &&
        range !== undefined &&
        !calendar.isPlaceholderData
      ) {
        event.preventDefault();
        const inRange = today !== null && today >= range.from && today <= range.to;
        setAdding(inRange ? today : (effectiveAnchor ?? range.from));
        return;
      }
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event) || isDialogOpen()) return;
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
  }, [view, effectiveAnchor, today, calendar.data, calendar.isPlaceholderData]);

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
  async function createTodo(date: string, title: string): Promise<boolean> {
    const timed = timeInDay(title, date);
    try {
      const item = await ipc.createItem({
        itemType: "todo",
        title: timed?.title ?? title,
        content: null,
        contentFormat: null,
        priority: null,
        scheduled: { date, time: timed?.time ?? null },
        due: null,
        reminderAt: null,
        projectId: null,
      });
      showCreated(item);
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  /** 显示这次创建的查看与回收撤销。 */
  function showCreated(item: ItemDto): void {
    useToastStore.getState().push(
      "success",
      t("capture.created", { title: item.title }),
      UNDO_MS,
      {
        label: t("capture.undo"),
        undo: true,
        onClick: () => void ipc.undoCreatedItem(item.id, item.updatedAt).catch(reportError),
      },
      openItem === null
        ? undefined
        : { label: t("capture.view"), onClick: () => openItem(item.id) },
    );
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
      .then((saved) => {
        useToastStore.getState().push(
          "success",
          t("calendar.scheduled", {
            title: payload.item.title,
            date: formatDate(parseISO(date), "monthDay"),
          }),
          UNDO_MS,
          {
            label: t("today.undo"),
            undo: true,
            onClick: () => {
              ipc
                .rescheduleItem(payload.item.id, {
                  kind: "restore",
                  scheduled: previous,
                  inInbox: payload.item.inInbox ?? false,
                  revision: saved.updatedAt,
                })
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
  const docked = width >= LAYOUT.dockedBacklog;
  const showSide = sideOpen ?? docked;
  const stackedWeek = view === "week" && width < LAYOUT.stackedCalendarWeek;
  return (
    <section ref={rootRef} aria-label={t("calendar.label")} className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <p role="status" className="sr-only">
          {announcement}
        </p>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-text tabular-nums">{title}</h1>
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
          <div className="flex flex-wrap items-center gap-3">
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
            <div
              role="grid"
              aria-label={title}
              // 翻页后新一页的数据到之前，网格还是上一页：调淡并标为忙，免得和新标题对不上。
              aria-busy={calendar.isPlaceholderData}
              onKeyDown={moveBetweenDays}
              className={cx(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                "transition-opacity duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
                calendar.isPlaceholderData && "pointer-events-none opacity-50",
              )}
            >
              <div
                role="row"
                className={cx(
                  "grid grid-cols-7 border-b border-border bg-surface",
                  stackedWeek && "sr-only",
                )}
              >
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
                  <div
                    key={week[0]}
                    role="row"
                    className={
                      stackedWeek
                        ? "flex min-h-0 flex-col overflow-y-auto"
                        : "grid min-h-0 grid-cols-7"
                    }
                  >
                    {week.map((date) => (
                      <DayCell
                        key={date}
                        date={date}
                        anchor={effectiveAnchor}
                        today={data.today}
                        view={view}
                        stacked={stackedWeek}
                        entries={groups.get(date) ?? []}
                        adding={adding === date}
                        onAdd={(on) =>
                          setAdding((current) => (on ? date : current === date ? null : current))
                        }
                        onCreate={createTodo}
                        onConfigure={(day, text) => {
                          const active = document.activeElement;
                          const opener =
                            active instanceof HTMLElement && active !== document.body
                              ? active
                              : (rootRef.current?.querySelector<HTMLElement>(
                                  `[data-calendar-day="${day}"] [data-day-add]`,
                                ) ?? null);
                          setCreateDraft({ date: day, text, opener });
                        }}
                        onExpand={(day) => {
                          expandedDay.current = day;
                          setAnchor(day);
                          switchView("week");
                          setAnnouncement(
                            t("calendar.expanded", {
                              date: formatDate(parseISO(day), "monthDayWeekday"),
                            }),
                          );
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            {showSide &&
              (docked ? (
                <Unscheduled items={data.unscheduled} />
              ) : (
                <BacklogSheet items={data.unscheduled} onClose={() => setSideOpen(false)} />
              ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging !== null && (
              <div className="w-48 rotate-1 rounded-md bg-surface px-2 py-1.5 text-xs text-text shadow-lg ring-2 ring-primary">
                <span className="block truncate">{dragging.item.title}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
        {createDraft !== null && (
          <CalendarCreateDialog
            today={data.today}
            date={createDraft.date}
            text={createDraft.text}
            opener={createDraft.opener}
            onClose={() => setCreateDraft(null)}
            onCreated={showCreated}
          />
        )}
      </div>
    </section>
  );
}

/** 日历落点使用同一新增配置，关闭后还原入口焦点。 */
function CalendarCreateDialog({
  today,
  date,
  text,
  opener,
  onClose,
  onCreated,
}: {
  today: string;
  date: string;
  text: string | null;
  opener: HTMLElement | null;
  onClose: () => void;
  onCreated: (item: ItemDto) => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("[required]")?.focus();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);
  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-label={t("calendar.addOn", { date: formatDate(parseISO(date), "monthDay") })}
      className="fixed inset-0 m-auto h-[min(44rem,calc(100dvh-2rem))] w-[min(38rem,calc(100vw-2rem))] max-h-none max-w-none overflow-hidden rounded-xl border-0 bg-surface p-0 shadow-lg backdrop:bg-black/30"
      onCancel={(event) => event.preventDefault()}
    >
      <CreateConfiguration
        embedded
        importOnOpen={text === null}
        kind="todo"
        today={today}
        targetDate={date}
        seed={text === null ? null : { id: 1, draft: textDraft(text) }}
        onDone={onClose}
        onCreated={onCreated}
      />
    </dialog>
  );
}
