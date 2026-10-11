import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@/components";
import { toAppError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import type { DryRunResultDto } from "@/lib/ipc";
import { cx } from "@/lib/cx";

/** [`DryRunPanel`] 的 Props。 */
export type DryRunPanelProps = {
  /** 要试运行的定义（可以是还没保存的草稿）。 */
  definitionJson: string;
};

/** 试运行的状态：还没跑 / 结果 / 出错的说明。 */
type Outcome =
  | { kind: "idle" }
  | { kind: "result"; result: DryRunResultDto }
  | { kind: "error"; message: string };

/**
 * 试运行面板：输入一个样例（网址 / 文字 / 文件路径），预览这份 Workflow 会创建什么。
 * 全程不写任何数据——不创建条目、不留运行记录（实施计划 5.7）。
 *
 * @param props 当前的定义。
 * @returns 面板。
 */
export function DryRunPanel({ definitionJson }: DryRunPanelProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"text" | "file">("text");
  const [value, setValue] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [running, setRunning] = useState(false);

  /** 运行一次。 */
  function run(): void {
    setRunning(true);
    ipc
      .dryRunWorkflow(definitionJson, { kind, value })
      .then((result) => setOutcome({ kind: "result", result }))
      .catch((error: unknown) => {
        const app = toAppError(error);
        const shown =
          app.code === "WORKFLOW_INVALID" || app.code === "INVALID_INPUT"
            ? app.message
            : t(`error.${app.code}`, { defaultValue: t("error.UNKNOWN") });
        setOutcome({ kind: "error", message: shown });
      })
      .finally(() => setRunning(false));
  }

  return (
    <section aria-label={t("workflows.dryRun.label")} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-text">{t("workflows.dryRun.title")}</h3>
      <p className="text-xs text-muted">{t("workflows.dryRun.hint")}</p>
      <div className="flex gap-2">
        <select
          aria-label={t("workflows.dryRun.kind")}
          value={kind}
          onChange={(event) => setKind(event.target.value === "file" ? "file" : "text")}
          className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-text"
        >
          <option value="text">{t("workflows.dryRun.kindText")}</option>
          <option value="file">{t("workflows.dryRun.kindFile")}</option>
        </select>
        <Input
          aria-label={t("workflows.dryRun.sample")}
          placeholder={
            kind === "file"
              ? t("workflows.dryRun.filePlaceholder")
              : t("workflows.dryRun.textPlaceholder")
          }
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim() !== "") run();
          }}
          className="flex-1"
        />
        <Button size="sm" disabled={running || value.trim() === ""} onClick={run}>
          {t("workflows.dryRun.run")}
        </Button>
      </div>
      {outcome.kind === "error" && (
        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {outcome.message}
        </p>
      )}
      {outcome.kind === "result" && <DryRunResult result={outcome.result} />}
    </section>
  );
}

/** [`DryRunResult`] 的 Props。 */
type DryRunResultProps = {
  /** 试运行的结果。 */
  result: DryRunResultDto;
};

/**
 * 试运行的结果：会创建的条目预览 + 每一步的状态与耗时。
 *
 * @param props 结果。
 * @returns 结果视图。
 */
function DryRunResult({ result }: DryRunResultProps) {
  const { t } = useTranslation();
  return (
    <div aria-live="polite" className="flex flex-col gap-3 rounded-md border border-border p-3">
      {result.error !== null ? (
        <p className="text-sm text-danger">
          {t("workflows.dryRun.failed", { reason: result.error })}
        </p>
      ) : result.items.length === 0 ? (
        <p className="text-sm text-muted">{t("workflows.dryRun.nothing")}</p>
      ) : (
        <>
          <p className="text-xs text-muted">
            {t("workflows.dryRun.wouldCreate", { count: result.items.length })}
          </p>
          <ul className="flex flex-col gap-2">
            {result.items.map((item, index) => (
              <li key={index} className="rounded-md bg-surface-hover px-3 py-2">
                <p className="text-xs text-muted">
                  {t(`quickCreate.kind.${item.itemType}`)}
                  {item.inInbox ? ` · ${t("workflows.dryRun.inInbox")}` : ""}
                  {item.scheduled !== null ? ` · ${item.scheduled}` : ""}
                </p>
                <p className="text-sm font-medium text-text">{item.title}</p>
                {item.content !== null && (
                  <p className="mt-0.5 line-clamp-2 break-all text-xs text-muted">{item.content}</p>
                )}
                {item.tags.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-primary/10 px-2 text-xs text-primary"
                      >
                        {`#${tag}`}
                      </span>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <StepList steps={result.steps} />
    </div>
  );
}

/** [`StepList`] 的 Props。 */
export type StepListProps = {
  /** 要显示的 Step 记录。 */
  steps: DryRunResultDto["steps"];
};

/**
 * 每一步的状态与耗时（试运行与运行记录共用）。
 *
 * @param props Step 记录。
 * @returns 列表；没有记录时不渲染。
 */
export function StepList({ steps }: StepListProps) {
  const { t } = useTranslation();
  if (steps.length === 0) return null;
  return (
    <ol aria-label={t("workflows.steps")} className="flex flex-col gap-1 text-xs">
      {steps.map((step) => (
        <li key={step.index} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cx(
              "size-1.5 rounded-full",
              step.outcome === "ok" && "bg-success",
              step.outcome === "skipped" && "bg-muted",
              step.outcome === "failed" && "bg-danger",
            )}
          />
          <span className="font-mono text-text">{step.kind}</span>
          <span className="text-muted">{t(`workflows.stepOutcome.${step.outcome}`)}</span>
          <span className="ml-auto tabular-nums text-muted">{`${step.durationMs} ms`}</span>
          {step.message !== null && <span className="text-danger">{step.message}</span>}
        </li>
      ))}
    </ol>
  );
}
