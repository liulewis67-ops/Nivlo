import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { ipc } from "@/lib/ipc";
import type { WorkflowDto } from "@/lib/ipc";
import { useToastStore } from "@/stores/toast-store";

/** [`ScriptPermissionNotice`] 的 Props。 */
type ScriptPermissionNoticeProps = {
  workflow: WorkflowDto;
  /** 有未保存的修改（或这是新草稿）：此时显示的权限不是将要运行的，先保存再确认。 */
  unsaved: boolean;
  /** 确认成功（带回后端的最新状态）。 */
  onConfirmed: (next: WorkflowDto) => void;
};

/**
 * 脚本权限提示：含脚本的 Workflow 首次运行（或脚本 / 权限被修改）之前，必须由用户确认它能访问什么。
 *
 * @param props Workflow 与确认回调。
 * @returns 提示条；没有脚本时返回 `null`。
 */
export function ScriptPermissionNotice({
  workflow,
  unsaved,
  onConfirmed,
}: ScriptPermissionNoticeProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  if (workflow.scriptStatus === "none") return null;

  const hosts =
    workflow.scriptHosts.length === 0
      ? t("workflows.script.noNetwork")
      : workflow.scriptHosts.join(", ");

  /** 向后端确认当前脚本与权限。 */
  function confirm(): void {
    setBusy(true);
    ipc
      .confirmScriptPermissions(workflow.id)
      .then(onConfirmed)
      .catch(() => useToastStore.getState().push("error", t("workflows.script.confirmFailed")))
      .finally(() => setBusy(false));
  }

  if (workflow.scriptStatus === "confirmed") {
    return <p className="text-xs text-muted">{t("workflows.script.confirmed", { hosts })}</p>;
  }
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-hover px-3 py-2 text-sm"
    >
      <p className="text-text">{t("workflows.script.needsConfirmation", { hosts })}</p>
      <div>
        <Button size="sm" disabled={busy || unsaved} onClick={confirm}>
          {t("workflows.script.confirm")}
        </Button>
        {unsaved && (
          <span className="ml-2 text-xs text-muted">{t("workflows.script.saveFirst")}</span>
        )}
      </div>
    </div>
  );
}
