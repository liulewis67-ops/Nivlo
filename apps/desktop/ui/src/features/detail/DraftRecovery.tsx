import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { cx } from "@/lib/cx";
import { useDraftTransitionStore } from "@/stores/draft-transition-store";
import type { ItemDraftState } from "./use-item-draft";

/**
 * 保存失败提示；放弃需要二次确认，取消仅清除目的地。
 *
 * @param props 实例标识、失败原因与重试操作。
 * @returns 恢复提示。
 */
export function DraftRecovery({
  owner,
  problem,
  save,
  showBlocked = false,
  className,
}: Pick<ItemDraftState, "owner" | "problem" | "save"> & {
  showBlocked?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const transition = useDraftTransitionStore();
  const foreign =
    showBlocked && transition.blockedOwner !== null && transition.blockedOwner !== owner;
  const blocked = transition.blockedOwner === owner || foreign;
  const reason = foreign ? (transition.failedDraft?.message ?? problem) : problem;
  if (reason === null) return null;
  return (
    <div
      role="alert"
      className={cx(
        "flex flex-col gap-2 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs break-words text-text",
        className,
      )}
    >
      <p>{t("detail.saveFailed", { reason })}</p>
      {foreign && <p>{t("detail.leave.other", { title: transition.failedDraft?.title })}</p>}
      {blocked && (
        <p>
          {transition.confirmingDiscard && foreign
            ? t("detail.leave.confirmOther", { title: transition.failedDraft?.title })
            : t(transition.confirmingDiscard ? "detail.leave.confirm" : "detail.leave.message")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {blocked && transition.confirmingDiscard ? (
          <>
            <Button
              size="sm"
              disabled={transition.busy}
              onClick={() => transition.askDiscard(false)}
            >
              {t("detail.leave.back")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={transition.busy}
              onClick={() => void transition.discard()}
            >
              {t("detail.leave.confirmDiscard")}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              disabled={transition.busy}
              onClick={() => (blocked ? transition.retry() : void save())}
            >
              {t("detail.retry")}
            </Button>
            {blocked && (
              <>
                <Button
                  size="sm"
                  onClick={(event) => {
                    const editor = event.currentTarget.closest("aside, article");
                    transition.cancel();
                    editor?.querySelector<HTMLElement>("input, textarea")?.focus();
                  }}
                >
                  {t("detail.leave.stay")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={transition.busy}
                  onClick={() => transition.askDiscard(true)}
                >
                  {t("detail.leave.discard")}
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
