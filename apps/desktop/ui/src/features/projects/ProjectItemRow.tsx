import { useTranslation } from "react-i18next";
import { useOpenItem } from "@/features/detail";
import { TodoCheck } from "@/features/today";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import type { ItemDto } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";

/** [`ProjectItemRow`] 的 Props。 */
export type ProjectItemRowProps = {
  /** 这一行的条目。 */
  item: ItemDto;
};

/**
 * 项目 / 标签视图里的一行：待办前有勾选框，标题（点击打开详情）、优先级与计划日期。
 *
 * 勾选直接调用后端，列表由数据变更事件刷新；已完成的待办划线并沉到列表底部。
 *
 * @param props 条目。
 * @returns 列表项。
 */
export function ProjectItemRow({ item }: ProjectItemRowProps) {
  const { t } = useTranslation();
  const openItem = useOpenItem();
  const done = item.status === "done";

  /** 完成或重新打开；失败统一提示。 */
  function toggle(): void {
    const request = done ? ipc.reopenItem(item.id) : ipc.completeItem(item.id);
    request.catch(reportError);
  }

  return (
    <li
      className={cx(
        "group flex items-center gap-3 rounded-md px-2 py-2",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard) hover:bg-surface-hover",
      )}
    >
      {item.itemType === "todo" ? (
        <TodoCheck
          checked={done}
          label={t(done ? "projects.reopen" : "projects.complete", { title: item.title })}
          onToggle={toggle}
        />
      ) : (
        <span aria-hidden="true" className="w-4 shrink-0 text-center text-xs text-muted">
          {t(`quickCreate.kind.${item.itemType}`).slice(0, 1)}
        </span>
      )}
      {openItem === null ? (
        <span className="min-w-0 flex-1 truncate text-sm text-text">{item.title}</span>
      ) : (
        <button
          type="button"
          onClick={() => openItem(item.id)}
          className={cx(
            "min-w-0 flex-1 truncate text-left text-sm",
            done ? "text-muted line-through" : "text-text",
          )}
        >
          {item.title}
        </button>
      )}
      {item.priority !== "none" && (
        <span
          className={cx(
            "shrink-0 rounded-full px-2 py-0.5 text-xs",
            item.priority === "high" && "bg-danger/10 text-danger",
            item.priority === "medium" && "bg-primary/10 text-primary",
            item.priority === "low" && "bg-surface-hover text-muted",
          )}
        >
          {t(`detail.priority.${item.priority}`)}
        </span>
      )}
      <span className="w-20 shrink-0 text-right text-xs text-muted tabular-nums">
        {item.scheduled?.date.slice(5) ?? t("projects.noDate")}
      </span>
    </li>
  );
}
