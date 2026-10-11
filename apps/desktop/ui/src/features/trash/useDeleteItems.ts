import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";

/** 删除后「撤销」提示停留多久（毫秒）。 */
export const DELETE_UNDO_MS = 6000;

/** [`useDeleteItems`] 返回的操作。 */
export type DeleteActions = {
  /**
   * 把条目移进回收站，并给出可撤销的提示（撤销 = 从回收站恢复）。
   *
   * @param ids 被删除的条目 ID。
   * @param title 只有一条时，用于提示文案里的标题。
   * @returns 是否成功；失败时已经弹出错误提示。
   */
  remove: (ids: string[], title?: string) => Promise<boolean>;
};

/**
 * 删除条目（软删除，进回收站）：成功后给出「撤销」，失败时提示原因且什么都不变。
 *
 * 列表由后端的数据变更事件刷新，所以不需要手动改缓存。
 *
 * @returns 删除操作。
 */
export function useDeleteItems(): DeleteActions {
  const { t } = useTranslation();

  /** 移进回收站；成功后显示可撤销的 Toast。 */
  async function remove(ids: string[], title?: string): Promise<boolean> {
    if (ids.length === 0) return false;
    try {
      await ipc.deleteItems(ids);
    } catch (error) {
      reportError(error);
      return false;
    }
    useToastStore
      .getState()
      .push(
        "success",
        ids.length === 1 && title !== undefined
          ? t("trash.deleted", { title })
          : t("trash.deletedMany", { count: ids.length }),
        DELETE_UNDO_MS,
        {
          label: t("today.undo"),
          onClick: () => {
            ipc.restoreDeletedItems(ids).catch(reportError);
          },
        },
      );
    return true;
  }

  return { remove };
}
