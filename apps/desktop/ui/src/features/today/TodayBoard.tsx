import type { TodayViewDto } from "@/lib/ipc";
import { TodayList } from "./TodayList";
import { useCompleteTodo } from "./useCompleteTodo";
import { useReorderToday } from "./useReorderToday";
import { useRescheduleTodo } from "./useRescheduleTodo";

/** [`TodayBoard`] 的 Props。 */
export type TodayBoardProps = {
  /** 后端返回的 Today 视图（已排序）。 */
  view: TodayViewDto;
};

/**
 * 可交互的 Today 列表：把完成 / 撤销、排序、推迟的操作接到 [`TodayList`] 上。
 *
 * 悬浮面板与主窗口的 Today 页共用它，所以两个窗口的行为（乐观更新、撤销提示、
 * 失败回滚）完全一致，并且都通过同一份 Today 查询缓存与后端事件保持同步。
 *
 * @param props 后端返回的 Today 视图。
 * @returns 列表元素；没有任何内容时返回 `null`，由调用方显示空状态。
 */
export function TodayBoard({ view }: TodayBoardProps) {
  const { complete, reopen } = useCompleteTodo();
  const move = useReorderToday();
  const { postpone } = useRescheduleTodo();
  return (
    <TodayList
      view={view}
      onComplete={(item) => void complete(item)}
      onMove={(activeId, overId) => void move(activeId, overId)}
      onPostpone={(item, kind) => void postpone(item, kind)}
      onReopen={(item) => void reopen(item)}
    />
  );
}
