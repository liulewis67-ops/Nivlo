import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import type { CaptureFeedback } from "./use-drop-capture";

/** [`CaptureFeedbackBar`] 的 Props。 */
export type CaptureFeedbackBarProps = {
  /** 当前反馈。 */
  feedback: CaptureFeedback;
  /** 点击「撤销」。 */
  onUndo: () => void;
  /** 点击「编辑」：打开主窗口继续整理。 */
  onEdit: () => void;
  /** 关闭反馈。 */
  onDismiss: () => void;
  /** 指针进入 / 离开反馈条：停留时不自动消失。 */
  onHoldChange: (held: boolean) => void;
  /** 编辑器内流式布局，不覆盖固定操作栏。 */
  inline?: boolean;
};

/**
 * 捕获后的反馈条：「已创建 ✓ [撤销] [编辑]」（产品文档 §27.1）。
 *
 * 用 `role="status"` 让屏幕阅读器播报结果；失败与不支持的来源给出明确原因与出路，
 * 而不是只闪一下。
 *
 * @param props 反馈与操作。
 * @returns 反馈条。
 */
export function CaptureFeedbackBar({
  feedback,
  onUndo,
  onEdit,
  onDismiss,
  onHoldChange,
  inline = false,
}: CaptureFeedbackBarProps) {
  const { t } = useTranslation();
  const first = feedback.status === "created" ? feedback.items[0] : undefined;
  const count = feedback.status === "created" ? feedback.items.length : 0;
  return (
    <div
      role="status"
      aria-live="polite"
      onPointerEnter={() => onHoldChange(true)}
      onPointerLeave={() => onHoldChange(false)}
      className={
        inline
          ? "flex flex-wrap items-center gap-2 text-sm"
          : "nv-panel-in absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 shadow-lg"
      }
    >
      {feedback.status === "saving" && <p className="text-sm text-muted">{t("capture.saving")}</p>}
      {feedback.status === "created" && (
        <>
          <span aria-hidden="true" className="text-primary">
            {"✓"}
          </span>
          <p className="min-w-0 flex-1 truncate text-sm text-text">
            {count > 1
              ? t("capture.createdMany", { count })
              : t("capture.created", { title: first?.title ?? "" })}
          </p>
          <Button size="sm" variant="ghost" onClick={onUndo}>
            {t("capture.undo")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            {t("capture.view")}
          </Button>
        </>
      )}
      {feedback.status === "unsupported" && (
        <>
          <p className="min-w-0 flex-1 text-sm text-text">
            {t(`capture.unsupported.${feedback.reason}`)}
          </p>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t("capture.dismiss")}
          </Button>
        </>
      )}
      {feedback.status === "failed" && (
        <>
          <p className="min-w-0 flex-1 text-sm text-text">
            {t("capture.failed", { message: feedback.message })}
          </p>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t("capture.dismiss")}
          </Button>
        </>
      )}
    </div>
  );
}
