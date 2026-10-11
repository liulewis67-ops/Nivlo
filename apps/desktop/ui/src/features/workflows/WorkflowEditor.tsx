import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ConfirmButton, Input, Switch, Textarea } from "@/components";
import { cx } from "@/lib/cx";
import { toAppError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import type { WorkflowDto } from "@/lib/ipc";
import { DryRunPanel } from "./DryRunPanel";
import {
  CONDITION_FIELDS,
  CONDITION_OPS,
  ITEM_TYPES,
  applyForm,
  describeMatcher,
  parseDefinition,
  stringify,
  toForm,
} from "./model/definition";
import type { ConditionForm, WorkflowForm } from "./model/definition";

/** 模板里可用的变量（原样展示，不经过 i18n 插值）。 */
const TEMPLATE_VARIABLES =
  "{{ input.title }}、{{ input.url }}、{{ input.text }}、{{ file.name }}、{{ now.date }}";

/** [`WorkflowEditor`] 的 Props。 */
export type WorkflowEditorProps = {
  /** 正在查看 / 编辑的 Workflow。 */
  workflow: WorkflowDto;
  /** 这是尚未保存的新建草稿。 */
  isNew: boolean;
  /** 保存成功（带回后端规范化后的结果）。 */
  onSaved: (saved: WorkflowDto) => void;
  /** 复制了一份（带回副本）。 */
  onDuplicated: (copy: WorkflowDto) => void;
  /** 删除成功。 */
  onDeleted: () => void;
  /** 关闭编辑区。 */
  onClose: () => void;
};

/** 表单一行的标签 + 控件布局。 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

/**
 * Workflow 编辑区：
 *
 * * 内置 Workflow 只读，只提供「复制并自定义」（产品文档 §14 Duplicate → Customize）；
 * * 用户 Workflow 默认用表单编辑（匹配条件 + 创建什么），表单表达不了的定义自动改用 JSON；
 * * 保存前由后端做完整校验，问题带位置显示在编辑区里；
 * * 下方的试运行用当前（未保存的）草稿，不写任何数据。
 *
 * @param props Workflow 与回调。
 * @returns 编辑区。
 */
export function WorkflowEditor({
  workflow,
  isNew,
  onSaved,
  onDuplicated,
  onDeleted,
  onClose,
}: WorkflowEditorProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(workflow.definitionJson);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const definition = useMemo(() => parseDefinition(text), [text]);
  const form = useMemo(() => (definition === null ? null : toForm(definition)), [definition]);
  const dirty = text !== workflow.definitionJson;
  const formAvailable = form !== null;
  const showForm = mode === "form" && formAvailable;

  /**
   * 表单变更写回草稿。
   *
   * @param patch 修改的字段。
   */
  function update(patch: Partial<WorkflowForm>): void {
    if (definition === null || form === null) return;
    setText(stringify(applyForm(definition, { ...form, ...patch })));
    setError(null);
  }

  /**
   * 修改某个条件。
   *
   * @param index 第几个条件。
   * @param patch 修改的字段。
   */
  function updateCondition(index: number, patch: Partial<ConditionForm>): void {
    if (form === null) return;
    update({
      conditions: form.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  }

  /** 保存。 */
  function save(): void {
    setBusy(true);
    ipc
      .saveWorkflow(text)
      .then(onSaved)
      .catch((cause: unknown) => {
        const app = toAppError(cause);
        setError(
          app.code === "WORKFLOW_INVALID"
            ? app.message
            : t(`error.${app.code}`, { defaultValue: t("error.UNKNOWN") }),
        );
      })
      .finally(() => setBusy(false));
  }

  /** 复制。 */
  function duplicate(): void {
    setBusy(true);
    ipc
      .duplicateWorkflow(workflow.id)
      .then(onDuplicated)
      .catch((cause: unknown) => setError(t(`error.${toAppError(cause).code}`)))
      .finally(() => setBusy(false));
  }

  /** 删除。 */
  function remove(): void {
    ipc
      .deleteWorkflow(workflow.id)
      .then(onDeleted)
      .catch((cause: unknown) => setError(t(`error.${toAppError(cause).code}`)));
  }

  const header = (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold text-text">{workflow.name}</h2>
        <p className="mt-0.5 font-mono text-xs text-muted">{workflow.id}</p>
      </div>
      <Button size="sm" variant="ghost" aria-label={t("workflows.close")} onClick={onClose}>
        {"✕"}
      </Button>
    </header>
  );

  if (workflow.readOnly) {
    const parsed = parseDefinition(workflow.definitionJson);
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
        {header}
        <p className="text-sm text-muted">{workflow.description}</p>
        <p className="rounded-md bg-surface-hover px-3 py-2 text-sm text-text">
          {t("workflows.readOnlyNotice")}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">{t("workflows.matches")}</dt>
          <dd className="text-text">
            {describeMatcher(parsed?.matcher) ?? t("workflows.matchesComplex")}
          </dd>
          <dt className="text-muted">{t("workflows.priority")}</dt>
          <dd className="tabular-nums text-text">{workflow.priority}</dd>
        </dl>
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-xs text-text">
          {workflow.definitionJson}
        </pre>
        {error !== null && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div>
          <Button disabled={busy} onClick={duplicate}>
            {t("workflows.duplicate")}
          </Button>
        </div>
        <DryRunPanel definitionJson={workflow.definitionJson} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      {header}
      <div role="tablist" aria-label={t("workflows.editMode")} className="flex gap-1">
        {(["form", "json"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={mode === item}
            disabled={item === "form" && !formAvailable}
            onClick={() => setMode(item)}
            className={cx(
              "rounded-md px-3 py-1 text-sm transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
              mode === item
                ? "bg-surface-hover font-medium text-text"
                : "text-muted hover:text-text",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {t(`workflows.mode.${item}`)}
          </button>
        ))}
      </div>
      {mode === "form" && !formAvailable && (
        <p className="text-xs text-muted">{t("workflows.formUnavailable")}</p>
      )}

      {showForm ? (
        <div className="flex flex-col gap-4">
          <Field label={t("workflows.field.name")}>
            <Input value={form.name} onChange={(e) => update({ name: e.target.value })} />
          </Field>
          <Field label={t("workflows.field.description")}>
            <Input
              value={form.description}
              onChange={(e) => update({ description: e.target.value })}
            />
          </Field>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium text-muted">{t("workflows.when")}</legend>
            {form.conditions.map((condition, index) => (
              <div key={index} className="flex gap-2">
                <select
                  aria-label={t("workflows.condition.field", { n: index + 1 })}
                  value={condition.field}
                  onChange={(e) => updateCondition(index, { field: e.target.value })}
                  className="h-9 w-40 rounded-md border border-border bg-surface px-2 text-sm text-text"
                >
                  {[...new Set([...CONDITION_FIELDS, condition.field])].map((field) => (
                    <option key={field} value={field}>
                      {t(`workflows.fieldName.${field}`, { defaultValue: field })}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t("workflows.condition.op", { n: index + 1 })}
                  value={condition.op}
                  onChange={(e) => updateCondition(index, { op: e.target.value })}
                  className="h-9 w-32 rounded-md border border-border bg-surface px-2 text-sm text-text"
                >
                  {CONDITION_OPS.map((op) => (
                    <option key={op} value={op}>
                      {t(`workflows.op.${op}`)}
                    </option>
                  ))}
                </select>
                {condition.op !== "exists" && (
                  <Input
                    aria-label={t("workflows.condition.value", { n: index + 1 })}
                    value={condition.value}
                    onChange={(e) => updateCondition(index, { value: e.target.value })}
                    className="min-w-0 flex-1"
                  />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("workflows.condition.remove", { n: index + 1 })}
                  disabled={form.conditions.length <= 1}
                  onClick={() =>
                    update({ conditions: form.conditions.filter((_, i) => i !== index) })
                  }
                >
                  {"−"}
                </Button>
              </div>
            ))}
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  update({
                    conditions: [
                      ...form.conditions,
                      { field: "url.host", op: "equals", value: "" },
                    ],
                  })
                }
              >
                {t("workflows.condition.add")}
              </Button>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-xs font-medium text-muted">{t("workflows.then")}</legend>
            <Field label={t("workflows.field.itemType")}>
              <select
                value={form.itemType}
                onChange={(e) => update({ itemType: e.target.value })}
                className="h-9 w-40 rounded-md border border-border bg-surface px-2 text-sm text-text"
              >
                {ITEM_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`quickCreate.kind.${type}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("workflows.field.title")}>
              <Input value={form.title} onChange={(e) => update({ title: e.target.value })} />
            </Field>
            <Field label={t("workflows.field.content")}>
              <Textarea
                rows={2}
                value={form.content}
                onChange={(e) => update({ content: e.target.value })}
              />
            </Field>
            <Field label={t("workflows.field.tags")}>
              <Input
                placeholder={t("workflows.field.tagsPlaceholder")}
                value={form.tags}
                onChange={(e) => update({ tags: e.target.value })}
              />
            </Field>
            <p className="text-xs text-muted">
              {t("workflows.templateHint", { vars: TEMPLATE_VARIABLES })}
            </p>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-text">{t("workflows.field.inInbox")}</span>
              <Switch
                label={t("workflows.field.inInbox")}
                checked={form.inInbox}
                onCheckedChange={(checked) => update({ inInbox: checked })}
              />
            </div>
            {form.itemType !== "note" && (
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-text">{t("workflows.field.scheduledToday")}</span>
                <Switch
                  label={t("workflows.field.scheduledToday")}
                  checked={form.scheduledToday}
                  onCheckedChange={(checked) => update({ scheduledToday: checked })}
                />
              </div>
            )}
          </fieldset>
        </div>
      ) : (
        <Textarea
          aria-label={t("workflows.mode.json")}
          spellCheck={false}
          rows={16}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          className="font-mono text-xs"
        />
      )}

      {error !== null && (
        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={busy || (!dirty && !isNew)} onClick={save}>
          {t("workflows.save")}
        </Button>
        {!isNew && (
          <Button variant="secondary" disabled={busy} onClick={duplicate}>
            {t("workflows.duplicate")}
          </Button>
        )}
        {!isNew && (
          <ConfirmButton
            className="ml-auto"
            label={t("workflows.delete")}
            confirmLabel={t("workflows.deleteConfirm")}
            onConfirm={remove}
          />
        )}
      </div>

      <hr className="border-border" />
      <DryRunPanel definitionJson={text} />
    </div>
  );
}
