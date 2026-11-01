import { useTranslation } from "react-i18next";
import { Button } from "./Button";

/**
 * 查询的加载/失败提示；错误播报由现有全局 QueryCache 负责，此处保留可见的重试入口。
 *
 * @param props 查询状态与重试动作。
 * @returns 提示或空节点。
 */
export function LoadFeedback({
  loading,
  failed,
  onRetry,
}: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (failed)
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm text-danger">
        <p>{t("common.loadFailed")}</p>
        <Button size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  if (loading)
    return (
      <p role="status" className="px-4 py-3 text-sm text-muted">
        {t("common.loading")}
      </p>
    );
  return null;
}
