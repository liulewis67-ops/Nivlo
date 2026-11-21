import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox } from "@/components";
import { toAppError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import type { WorkflowDto, WorkflowImportPreviewDto } from "@/lib/ipc";

/** [`ImportPreviewPanel`] 的 Props。 */
type ImportPreviewPanelProps = {
  /** 后端校验过的导入预览。 */
  preview: WorkflowImportPreviewDto;
  /** 导入成功（带回保存后的 Workflow）。 */
  onImported: (imported: WorkflowDto) => void;
  /** 放弃导入。 */
  onCancel: () => void;
};

/**
 * 导入预览：在写入任何数据之前，把这份定义的来源、用到的 Step 和请求的全部权限展示给用户，
 * 用户勾选确认后才能导入。导入后默认禁用，含联网脚本的还需要在编辑区另行确认脚本权限。
 *
 * @param props 预览与回调。
 * @returns 预览面板。
 */
export function ImportPreviewPanel({ preview, onImported, onCancel }: ImportPreviewPanelProps) {
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 确认导入：把预览里规范化后的定义交给后端保存。 */
  function confirm(): void {
    setBusy(true);
    setError(null);
    ipc
      .importWorkflow(preview.definitionJson)
      .then(onImported)
      .catch((failure: unknown) => {
        const app = toAppError(failure);
        setError(
          app.code === "WORKFLOW_INVALID"
            ? app.message
            : t(`error.${app.code}`, { defaultValue: t("error.UNKNOWN") }),
        );
      })
      .finally(() => setBusy(false));
  }

  const hosts =
    preview.hosts.length === 0 ? t("workflows.import.noHosts") : preview.hosts.join(", ");
  return (
    <section
      aria-label={t("workflows.import.title")}
      className="flex h-full flex-col gap-4 overflow-y-auto p-5"
    >
      <h2 className="text-base font-semibold text-text">{t("workflows.import.title")}</h2>
      <p className="text-sm text-muted">{t("workflows.import.intro")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted">{t("workflows.import.name")}</dt>
        <dd className="text-text">{preview.name}</dd>
        <dt className="text-muted">{t("workflows.import.publisher")}</dt>
        <dd className="text-text">{preview.publisher ?? t("workflows.import.noPublisher")}</dd>
        {preview.description !== "" && (
          <>
            <dt className="text-muted">{t("workflows.import.description")}</dt>
            <dd className="text-text">{preview.description}</dd>
          </>
        )}
        <dt className="text-muted">{t("workflows.import.steps")}</dt>
        <dd className="font-mono text-text">{preview.stepKinds.join(" → ")}</dd>
        <dt className="text-muted">{t("workflows.import.network")}</dt>
        <dd className="text-text">
          {preview.network
            ? t("workflows.import.networkYes", { hosts })
            : t("workflows.import.networkNo")}
        </dd>
        <dt className="text-muted">{t("workflows.import.script")}</dt>
        <dd className="text-text">
          {preview.hasScript
            ? t("workflows.import.scriptYes", {
                hosts:
                  preview.scriptHosts.length === 0
                    ? t("workflows.import.noHosts")
                    : preview.scriptHosts.join(", "),
              })
            : t("workflows.import.scriptNo")}
        </dd>
      </dl>
      {preview.renamedFrom !== null && (
        <p className="rounded-md bg-surface-hover px-3 py-2 text-sm text-text">
          {t("workflows.import.renamed", { from: preview.renamedFrom, to: preview.id })}
        </p>
      )}
      <p className="text-xs text-muted">{t("workflows.import.disabledNotice")}</p>
      <Checkbox
        checked={agreed}
        onCheckedChange={setAgreed}
        label={t("workflows.import.agree")}
        disabled={busy}
      />
      {error !== null && (
        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={!agreed || busy} onClick={confirm}>
          {t("workflows.import.confirm")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t("workflows.import.cancel")}
        </Button>
      </div>
    </section>
  );
}
