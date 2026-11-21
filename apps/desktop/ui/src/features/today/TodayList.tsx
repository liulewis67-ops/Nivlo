import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "@/lib/cx";
import type { TodayItemDto, TodayViewDto } from "@/lib/ipc";
import { useDisplayStore } from "@/stores/display-store";
import { ItemTitle } from "./ItemTitle";
import { SortableTodoList } from "./SortableTodoList";
import { TodoCheck } from "./TodoCheck";
import type { PostponeKind } from "./useRescheduleTodo";

/** [`TodayList`] 的 Props。 */
export type TodayListProps = {
  /** 后端返回的 Today 视图（已排序）。 */
  view: TodayViewDto;
  /** 勾选一条待办或提示时调用。 */
  onComplete: (item: TodayItemDto) => void;
  /** 拖拽 / 键盘排序结束：`activeId` 被放到了 `overId` 的位置。 */
  onMove: (activeId: string, overId: string) => void;
  /** 把一条待办推迟到某个目标。 */
  onPostpone: (item: TodayItemDto, kind: PostponeKind) => void;
  /** 取消勾选一条今日已完成的待办或提示时调用。 */
  onReopen: (item: TodayItemDto) => void;
  /** 删除一条待办（Delete 键）；不传时 Delete 不起作用（悬浮窗没有删除权限）。 */
  onDelete?: ((item: TodayItemDto) => void) | undefined;
};

/**
 * 把计划时间格式化为 `HH:MM`；全天事项返回 `null`。
 *
 * @param item Today 条目。
 * @returns 时间文本或 `null`。
 */
function timeLabel(item: TodayItemDto): string | null {
  const time = item.scheduled?.time;
  return time === null || time === undefined ? null : time.slice(0, 5);
}

/** 提示前的小灯泡（线性图标，占待办拖动把手的位置，勾选框与待办上下对齐）。 */
function TipGlyph() {
  return (
    <span aria-hidden="true" className="flex h-5 w-4 shrink-0 items-center justify-center text-tip">
      <svg
        viewBox="0 0 16 16"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 2a4 4 0 0 0-2.3 7.3c.5.4.8.9.8 1.4V11h3v-.3c0-.5.3-1 .8-1.4A4 4 0 0 0 8 2z" />
        <path d="M6.5 13.2h3" />
      </svg>
    </span>
  );
}

/**
 * Today 列表：待办（逾期的带标记）、提示、今日已完成（删除线，位于底部）。
 *
 * 提示和待办一样可以勾掉：勾掉后移到「今日已完成」，不再计入剩余数量；它用圆形勾选框和灯泡图标
 * 与待办区分，不能拖动排序（按时间排列）。
 *
 * 只负责展示后端给出的结果，不在前端判断"哪些 Item 属于 Today"或排序（前端规范 §1）。
 * 勾选、取消勾选、拖拽排序与推迟都由回调处理。
 *
 * @param props 后端返回的 Today 视图与完成 / 重新打开回调。
 * @returns 列表元素；没有任何内容时返回 `null`，由调用方显示空状态。
 */
export function TodayList({
  view,
  onComplete,
  onMove,
  onPostpone,
  onReopen,
  onDelete,
}: TodayListProps) {
  const { t } = useTranslation();
  const hideCompleted = useDisplayStore((state) => state.hideCompleted);
  const completed = hideCompleted ? [] : view.completed;
  const rootRef = useRef<HTMLDivElement>(null);
  /** 刚取消勾选、等它回到待办列表后要聚焦的那一条。 */
  const reopenedId = useRef<string | null>(null);

  // 取消勾选后那一条从「已完成」回到待办列表，原来的勾选框随之消失、焦点掉到页面上：
  // 改为聚焦它回到待办列表后的完成框（再按一次空格又能完成）。焦点已在别处时不抢。
  useEffect(() => {
    const id = reopenedId.current;
    if (id === null) return;
    const row = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-todo-id]") ?? [])].find(
      (element) => element.dataset.todoId === id,
    );
    const box = row?.querySelector<HTMLElement>("[role=checkbox]");
    if (box === null || box === undefined) return;
    reopenedId.current = null;
    if (document.activeElement === null || document.activeElement === document.body) box.focus();
  }, [view]);

  if (view.todos.length === 0 && view.tips.length === 0 && completed.length === 0) {
    return null;
  }
  return (
    <div
      ref={rootRef}
      className="nv-scroll-hover flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
    >
      {view.todos.length > 0 && (
        <SortableTodoList
          todos={view.todos}
          today={view.date}
          onComplete={onComplete}
          onMove={onMove}
          onPostpone={onPostpone}
          onDelete={onDelete}
        />
      )}
      {view.tips.length > 0 && (
        <ul aria-label={t("today.section.tips")} className="flex flex-col gap-0.5">
          {view.tips.map((item) => (
            <li
              key={item.id}
              data-todo-id={item.id}
              className="flex items-center gap-1.5 rounded-md py-1.5 pr-1 pl-0.5 text-sm text-text hover:bg-surface-hover"
            >
              <TipGlyph />
              <TodoCheck
                checked={false}
                shape="round"
                label={t("today.complete", { title: item.title })}
                onToggle={() => onComplete(item)}
              />
              {timeLabel(item) !== null && (
                <span className="shrink-0 text-xs text-muted tabular-nums">{timeLabel(item)}</span>
              )}
              <ItemTitle id={item.id} title={item.title} brief={item.brief} />
            </li>
          ))}
        </ul>
      )}
      {completed.length > 0 && (
        <ul aria-label={t("today.section.completed")} className="flex flex-col gap-1">
          {completed.map((item) => (
            <li
              key={item.id}
              className={cx("flex items-center gap-2 px-2 py-1 text-sm text-muted line-through")}
            >
              <TodoCheck
                checked
                shape={item.itemType === "tip" ? "round" : "square"}
                label={t("today.reopen", { title: item.title })}
                onToggle={() => {
                  if (rootRef.current?.contains(document.activeElement) === true) {
                    reopenedId.current = item.id;
                  }
                  onReopen(item);
                }}
              />
              <ItemTitle id={item.id} title={item.title} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
