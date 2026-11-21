import { useQuery } from "@tanstack/react-query";
import { parseISO } from "date-fns";
import { distanceToNow } from "@/lib/date-format";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { StepList } from "./DryRunPanel";
import { FailureActionButton } from "./FailureActionButton";

/**
 * 简单的 Run Inspector：最近的 Workflow 执行（新的在前），点开看每一步的状态与耗时。
 *
 * 输入只显示脱敏摘要（文字只有字数、网址不含查询串、文件只有文件名），
 * 所以这里不会泄露捕获的内容（实施计划 5.6）。
 *
 * @returns 运行记录列表。
 */
export function RunInspector() {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: queryKeys.workflowRuns(),
    queryFn: () => ipc.listWorkflowRuns(100),
    staleTime: 0,
  });

  if (runs.data === undefined) return null;
  if (runs.data.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
        <p className="text-base font-medium text-text">{t("workflows.runs.emptyTitle")}</p>
        <p className="max-w-sm text-sm text-muted">{t("workflows.runs.emptyHint")}</p>
      </div>
    );
  }
  return (
    <ul aria-label={t("workflows.runs.list")} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {runs.data.map((run) => {
        const open = openId === run.id;
        return (
          <li key={run.id} className="rounded-md hover:bg-surface-hover">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : run.id)}
              className="flex w-full items-center gap-3 px-2 py-2.5 text-left"
            >
              <span
                className={cx(
                  "shrink-0 rounded-full px-2 py-0.5 text-xs",
                  run.status === "succeeded" && "bg-success/15 text-success",
                  run.status === "failed" && "bg-danger/15 text-danger",
                  run.status === "skipped" && "bg-surface-hover text-muted",
                )}
              >
                {t(`workflows.runs.status.${run.status}`)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text">{run.workflowName}</span>
                <span className="block truncate text-xs text-muted">{run.inputSummary}</span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted">
                {distanceToNow(parseISO(run.startedAt), true)}
              </span>
            </button>
            {open && (
              <div className="flex flex-col gap-2 px-2 pb-3">
                {run.errorMessage !== null && (
                  <p className="text-xs text-danger">
                    {t("workflows.runs.fellBack", { reason: run.errorMessage })}
                  </p>
                )}
                <FailureActionButton action={run.errorAction} />
                <p className="text-xs text-muted">
                  {t("workflows.runs.summary", {
                    count: run.itemsCreated,
                    ms: run.durationMs,
                  })}
                </p>
                <StepList steps={run.steps} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
