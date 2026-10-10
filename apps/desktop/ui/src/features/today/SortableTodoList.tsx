import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { Announcements, DragEndEvent, Modifier } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import { cx } from "@/lib/cx";
import type { TodayItemDto } from "@/lib/ipc";
import { TodoCheck } from "./TodoCheck";

/** 拖动超过这个距离（px）才算开始拖拽，避免点击勾选框 / 手柄被误判成拖拽。 */
const DRAG_ACTIVATION_DISTANCE_PX = 4;

/** 只允许竖直方向移动：列表是单列的，横向偏移只会让行"飘"出面板。 */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** [`SortableTodoList`] 的 Props。 */
export type SortableTodoListProps = {
  /** 待办，已按 Today Order 排序。 */
  todos: TodayItemDto[];
  /** 勾选一条待办。 */
  onComplete: (item: TodayItemDto) => void;
  /** 拖拽 / 键盘排序结束：`activeId` 被放到了 `overId` 的位置。 */
  onMove: (activeId: string, overId: string) => void;
};

/** [`SortableTodo`] 的 Props。 */
type SortableTodoProps = {
  /** 这一行的待办。 */
  item: TodayItemDto;
  /** 勾选回调。 */
  onComplete: (item: TodayItemDto) => void;
};

/**
 * 一行可排序的待办：左侧拖拽手柄（⠿，鼠标拖动或键盘 Space + 方向键），中间勾选框与标题。
 *
 * @param props 待办与勾选回调。
 * @returns 列表项。
 */
function SortableTodo({ item, onComplete }: SortableTodoProps) {
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
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx(
        "group flex items-center gap-1.5 rounded-md py-1.5 pr-2 pl-0.5 text-sm text-text",
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
      <span className="flex-1 truncate">{item.title}</span>
      {item.isOverdue && (
        <span className="shrink-0 rounded-sm bg-danger px-1.5 text-xs text-danger-contrast">
          {t("today.overdue")}
        </span>
      )}
    </li>
  );
}

/**
 * 可拖拽 / 可用键盘排序的待办列表（实施计划 1.7）。
 *
 * 鼠标：按住 ⠿ 拖动；键盘：Tab 到手柄，Space 拿起，↑↓ 移动，Space 放下，Esc 取消。
 * 拖动结束立即回调 `onMove`，由上层做乐观更新并持久化。读屏播报使用中文文案。
 *
 * @param props 待办与回调。
 * @returns 带 \`aria-label\` 的待办列表。
 */
export function SortableTodoList({ todos, onComplete, onMove }: SortableTodoListProps) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  /** 按 ID 取标题，用于读屏播报。 */
  const titleOf = (id: string | number): string =>
    todos.find((todo) => todo.id === id)?.title ?? "";
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("today.reorder.picked", { title: titleOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over === null
        ? ""
        : t("today.reorder.moved", {
            title: titleOf(active.id),
            position: todos.findIndex((todo) => todo.id === over.id) + 1,
            total: todos.length,
          }),
    onDragEnd: ({ active, over }) =>
      over === null
        ? t("today.reorder.cancelled", { title: titleOf(active.id) })
        : t("today.reorder.dropped", {
            title: titleOf(active.id),
            position: todos.findIndex((todo) => todo.id === over.id) + 1,
          }),
    onDragCancel: ({ active }) => t("today.reorder.cancelled", { title: titleOf(active.id) }),
  };

  /** 拖拽结束：位置有变化才通知上层。 */
  function handleDragEnd({ active, over }: DragEndEvent): void {
    if (over !== null && active.id !== over.id) onMove(String(active.id), String(over.id));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={handleDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t("today.reorder.instructions") },
      }}
    >
      <SortableContext items={todos.map((todo) => todo.id)} strategy={verticalListSortingStrategy}>
        <ul aria-label={t("today.section.todos")} className="flex flex-col gap-0.5">
          {todos.map((item) => (
            <SortableTodo key={item.id} item={item} onComplete={onComplete} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
