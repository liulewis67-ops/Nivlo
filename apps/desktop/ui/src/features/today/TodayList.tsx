import { useTranslation } from "react-i18next";
import { cx } from "@/lib/cx";
import type { TodayItemDto, TodayViewDto } from "@/lib/ipc";

/** 提示条目前的图标。 */
const TIP_ICON = "💡";

/** [`TodayList`] 的 Props。 */
export type TodayListProps = {
  /** 后端返回的 Today 视图（已排序）。 */
  view: TodayViewDto;
  /** 勾选一条待办时调用。 */
  onComplete: (item: TodayItemDto) => void;
  /** 取消勾选一条今日已完成的待办时调用。 */
  onReopen: (item: TodayItemDto) => void;
};

/** [`TodoCheck`] 的 Props。 */
type TodoCheckProps = {
  /** 是否已完成。 */
  checked: boolean;
  /** 可访问名称（含标题）。 */
  label: string;
  /** 点击时调用。 */
  onToggle: () => void;
};

/**
 * 待办前面的圆角方形勾选框：整个按钮都是点击目标，勾选时播放一个轻微的弹跳。
 *
 * @param props 状态、名称与回调。
 * @returns 勾选按钮。
 */
function TodoCheck({ checked, label, onToggle }: TodoCheckProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cx(
        "flex size-4 shrink-0 items-center justify-center rounded-sm border",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        checked
          ? "border-primary bg-primary text-primary-contrast"
          : "border-border bg-surface hover:border-primary",
      )}
    >
      <svg
        viewBox="0 0 16 16"
        className={cx("size-3", checked ? "opacity-100" : "opacity-0")}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
    </button>
  );
}

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

/**
 * Today 列表：待办（逾期的带标记）、提示、今日已完成（删除线，位于底部）。
 *
 * 只负责展示后端给出的结果，不在前端判断"哪些 Item 属于 Today"或排序（前端规范 §1）。
 * 勾选 / 取消勾选由回调处理；排序、推迟在实施计划 1.7、1.8 加入。
 *
 * @param props 后端返回的 Today 视图与完成 / 重新打开回调。
 * @returns 列表元素；没有任何内容时返回 `null`，由调用方显示空状态。
 */
export function TodayList({ view, onComplete, onReopen }: TodayListProps) {
  const { t } = useTranslation();
  if (view.todos.length === 0 && view.tips.length === 0 && view.completed.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
      {view.todos.length > 0 && (
        <ul aria-label={t("today.section.todos")} className="flex flex-col gap-1">
          {view.todos.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text hover:bg-surface-hover"
            >
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
          ))}
        </ul>
      )}
      {view.tips.length > 0 && (
        <ul aria-label={t("today.section.tips")} className="flex flex-col gap-1">
          {view.tips.map((item) => (
            <li key={item.id} className="flex items-center gap-2 px-2 text-sm text-muted">
              <span aria-hidden="true">{TIP_ICON}</span>
              {timeLabel(item) !== null && <span className="tabular-nums">{timeLabel(item)}</span>}
              <span className="flex-1 truncate">{item.title}</span>
            </li>
          ))}
        </ul>
      )}
      {view.completed.length > 0 && (
        <ul aria-label={t("today.section.completed")} className="flex flex-col gap-1">
          {view.completed.map((item) => (
            <li
              key={item.id}
              className={cx("flex items-center gap-2 px-2 py-1 text-sm text-muted line-through")}
            >
              <TodoCheck
                checked
                label={t("today.reopen", { title: item.title })}
                onToggle={() => onReopen(item)}
              />
              <span className="flex-1 truncate">{item.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
