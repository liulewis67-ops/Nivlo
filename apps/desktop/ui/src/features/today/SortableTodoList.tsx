import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { Announcements, CollisionDetection, DragEndEvent, Modifier } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu, Menu } from "@/components";
import type { MenuItemSpec } from "@/components";
import { cx } from "@/lib/cx";
import type { TodayItemDto } from "@/lib/ipc";
import { ItemTitle } from "./ItemTitle";
import { dueStatus } from "./model/due-status";
import { TodoCheck } from "./TodoCheck";
import type { PostponeKind } from "./useRescheduleTodo";

/** 拖动超过这个距离（px）才算开始拖拽，避免点击勾选框 / 手柄被误判成拖拽。 */
const DRAG_ACTIVATION_DISTANCE_PX = 4;

/** 推迟目标区域的 droppable ID 前缀，用来和待办行区分。 */
const ZONE_PREFIX = "postpone:";

/** 拖动待办时出现在面板底部的推迟目标。 */
const ZONE_KINDS: Exclude<PostponeKind, "today">[] = ["tomorrow", "later", "inbox"];

/** 只允许竖直方向移动：列表是单列的，横向偏移只会让行"飘"出面板。 */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * 碰撞检测：指针在某个推迟区域里就以它为准，否则按行之间的距离排序。
 * 两类目标分开计算，这样拖到区域上方时不会同时触发行的重新排列。
 *
 * @param args dnd-kit 提供的碰撞参数。
 * @returns 命中的 droppable。
 */
const detectCollisions: CollisionDetection = (args) => {
  /** 是否是推迟目标区域（而不是待办行）。 */
  const isZone = (id: string | number) => String(id).startsWith(ZONE_PREFIX);
  const zoneHits = pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => isZone(c.id)),
  });
  if (zoneHits.length > 0) return zoneHits;
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => !isZone(c.id)),
  });
};

/** [`SortableTodoList`] 的 Props。 */
export type SortableTodoListProps = {
  /** 待办，已按 Today Order 排序。 */
  todos: TodayItemDto[];
  /** 今天（`YYYY-MM-DD`），用来判断截止状态。 */
  today: string;
  /** 勾选一条待办。 */
  onComplete: (item: TodayItemDto) => void;
  /** 拖拽 / 键盘排序结束：`activeId` 被放到了 `overId` 的位置。 */
  onMove: (activeId: string, overId: string) => void;
  /** 把一条待办推迟到某个目标（菜单或拖到底部区域）。 */
  onPostpone: (item: TodayItemDto, kind: PostponeKind) => void;
};

/** [`SortableTodo`] 的 Props。 */
type SortableTodoProps = {
  /** 这一行的待办。 */
  item: TodayItemDto;
  /** 今天（`YYYY-MM-DD`）。 */
  today: string;
  /** 勾选回调。 */
  onComplete: (item: TodayItemDto) => void;
  /** 推迟回调。 */
  onPostpone: (item: TodayItemDto, kind: PostponeKind) => void;
};

/**
 * 一条待办的推迟菜单项：逾期的多一个「移到今天」。
 *
 * @param item 待办。
 * @param t 翻译函数。
 * @param onPostpone 选中时的回调。
 * @returns 菜单项描述（右键菜单与「⋯」菜单共用）。
 */
function postponeItems(
  item: TodayItemDto,
  t: (key: string) => string,
  onPostpone: (item: TodayItemDto, kind: PostponeKind) => void,
): MenuItemSpec[] {
  const kinds: PostponeKind[] = item.isOverdue
    ? ["today", "tomorrow", "later", "inbox"]
    : ["tomorrow", "later", "inbox"];
  return kinds.map((kind) => ({
    id: kind,
    label: t(`today.postpone.menu.${kind}`),
    onSelect: () => onPostpone(item, kind),
  }));
}

/**
 * 一行可排序的待办：左侧拖拽手柄（⠿，鼠标拖动或键盘 Space + 方向键），中间勾选框与标题，
 * 右侧「⋯」菜单；整行右键也能打开同一个推迟菜单。
 *
 * @param props 待办与回调。
 * @returns 列表项。
 */
function SortableTodo({ item, today, onComplete, onPostpone }: SortableTodoProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  const menuItems = postponeItems(item, t, onPostpone);
  const due = dueStatus(item, today);
  return (
    <ContextMenu items={menuItems}>
      <li
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className={cx(
          "group flex items-center gap-1.5 rounded-md py-1.5 pr-1 pl-0.5 text-sm text-text",
          "hover:bg-surface-hover",
          isDragging && "relative z-10 bg-surface shadow-md ring-1 ring-border",
        )}
      >
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={t("today.reorder.handle", { title: item.title })}
          className={cx(
            "flex h-5 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm",
            "text-muted opacity-40 group-hover:opacity-100 focus-visible:opacity-100",
            "focus-visible:outline-2 focus-visible:outline-focus active:cursor-grabbing",
          )}
          {...attributes}
          {...listeners}
        >
          <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
            <circle cx="5.5" cy="3.5" r="1.2" />
            <circle cx="10.5" cy="3.5" r="1.2" />
            <circle cx="5.5" cy="8" r="1.2" />
            <circle cx="10.5" cy="8" r="1.2" />
            <circle cx="5.5" cy="12.5" r="1.2" />
            <circle cx="10.5" cy="12.5" r="1.2" />
          </svg>
        </button>
        <TodoCheck
          checked={false}
          label={t("today.complete", { title: item.title })}
          onToggle={() => onComplete(item)}
        />
        <ItemTitle id={item.id} title={item.title} />
        {due !== null && (
          <span
            className={cx(
              "shrink-0 rounded-sm border px-1.5 text-xs",
              due === "tomorrow" ? "border-border text-muted" : "border-danger text-danger",
            )}
          >
            {t(`today.due.${due}`)}
          </span>
        )}
        {item.isOverdue && (
          <span className="shrink-0 rounded-sm bg-danger px-1.5 text-xs text-danger-contrast">
            {t("today.overdue")}
          </span>
        )}
        <Menu
          items={menuItems}
          trigger={
            <button
              type="button"
              aria-label={t("today.postpone.more", { title: item.title })}
              className={cx(
                "flex size-5 shrink-0 items-center justify-center rounded-sm text-muted",
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                "hover:bg-surface-hover hover:text-text focus-visible:outline-2 focus-visible:outline-focus",
              )}
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
                <circle cx="3.5" cy="8" r="1.2" />
                <circle cx="8" cy="8" r="1.2" />
                <circle cx="12.5" cy="8" r="1.2" />
              </svg>
            </button>
          }
        />
      </li>
    </ContextMenu>
  );
}

/** [`PostponeZone`] 的 Props。 */
type PostponeZoneProps = {
  /** 这个区域代表的目标。 */
  kind: Exclude<PostponeKind, "today">;
};

/**
 * 拖动待办时出现的一个推迟目标；指针悬停时高亮。
 *
 * @param props 目标种类。
 * @returns 目标区域。
 */
function PostponeZone({ kind }: PostponeZoneProps) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `${ZONE_PREFIX}${kind}` });
  return (
    <div
      ref={setNodeRef}
      className={cx(
        "flex h-12 flex-1 items-center justify-center rounded-md border border-dashed text-sm",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        isOver
          ? "border-primary bg-primary text-primary-contrast"
          : "border-border bg-surface text-muted",
      )}
    >
      {t(`today.postpone.zone.${kind}`)}
    </div>
  );
}

/**
 * 可拖拽 / 可用键盘排序的待办列表（实施计划 1.7、1.8）。
 *
 * 排序：按住 ⠿ 拖动；键盘 Tab 到手柄，Space 拿起，↑↓ 移动，Space 放下，Esc 取消。
 * 推迟：拖动时面板底部出现「明天 / 下周一 / 收集箱」，放到上面即推迟；也可以右键或点「⋯」。
 * 拖动结束立即回调，由上层做乐观更新并持久化。读屏播报使用中文文案。
 *
 * @param props 待办与回调。
 * @returns 带 `aria-label` 的待办列表（及拖动时出现的推迟目标）。
 */
export function SortableTodoList({
  todos,
  today,
  onComplete,
  onMove,
  onPostpone,
}: SortableTodoListProps) {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  /** 按 ID 取标题，用于读屏播报。 */
  const titleOf = (id: string | number): string =>
    todos.find((todo) => todo.id === id)?.title ?? "";
  /** 某个待办当前是第几位（从 1 开始）。 */
  const positionOf = (id: string | number): number => todos.findIndex((todo) => todo.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("today.reorder.picked", { title: titleOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over === null || String(over.id).startsWith(ZONE_PREFIX)
        ? ""
        : t("today.reorder.moved", {
            title: titleOf(active.id),
            position: positionOf(over.id),
            total: todos.length,
          }),
    onDragEnd: ({ active, over }) =>
      over === null
        ? t("today.reorder.cancelled", { title: titleOf(active.id) })
        : String(over.id).startsWith(ZONE_PREFIX)
          ? ""
          : t("today.reorder.dropped", {
              title: titleOf(active.id),
              position: positionOf(over.id),
            }),
    onDragCancel: ({ active }) => t("today.reorder.cancelled", { title: titleOf(active.id) }),
  };

  /** 拖拽结束：放在推迟区域上就推迟，放在另一行上且位置有变化才通知排序。 */
  function handleDragEnd({ active, over }: DragEndEvent): void {
    setIsDragging(false);
    if (over === null) return;
    const overId = String(over.id);
    if (overId.startsWith(ZONE_PREFIX)) {
      const item = todos.find((todo) => todo.id === active.id);
      if (item !== undefined) onPostpone(item, overId.slice(ZONE_PREFIX.length) as PostponeKind);
    } else if (active.id !== over.id) {
      onMove(String(active.id), overId);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={detectCollisions}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={() => setIsDragging(true)}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setIsDragging(false)}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t("today.reorder.instructions") },
      }}
    >
      <SortableContext items={todos.map((todo) => todo.id)} strategy={verticalListSortingStrategy}>
        <ul aria-label={t("today.section.todos")} className="flex flex-col gap-0.5">
          {todos.map((item) => (
            <SortableTodo
              key={item.id}
              item={item}
              today={today}
              onComplete={onComplete}
              onPostpone={onPostpone}
            />
          ))}
        </ul>
      </SortableContext>
      {isDragging && (
        <div className="nv-panel-in absolute inset-x-2 bottom-2 z-20 flex gap-2">
          {ZONE_KINDS.map((kind) => (
            <PostponeZone key={kind} kind={kind} />
          ))}
        </div>
      )}
    </DndContext>
  );
}
