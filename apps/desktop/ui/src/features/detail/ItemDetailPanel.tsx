import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Textarea } from "@/components";
import { cx } from "@/lib/cx";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import type { ContentFormatDto, InboxEntryDto, ItemTypeDto, PriorityDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { buildPatch, dropSaved, toDraft } from "./model/item-draft";
import type { ItemDraft } from "./model/item-draft";
import { SourceSection } from "./SourceSection";

/** 停止输入多久之后自动保存（毫秒）。 */
export const AUTOSAVE_DELAY_MS = 700;

/** 类型选项，按展示顺序。 */
const TYPES: ItemTypeDto[] = ["todo", "note", "tip"];

/** 优先级选项，按展示顺序。 */
const PRIORITIES: PriorityDto[] = ["none", "low", "medium", "high"];

/** 内容格式选项。 */
const FORMATS: ContentFormatDto[] = ["plain", "markdown"];

/** 保存状态。 */
type SaveStatus = "idle" | "saving" | "saved" | "error";

/** [`ItemDetailPanel`] 的 Props。 */
export type ItemDetailPanelProps = {
  /** 要编辑的 Item。切换到另一个 Item 时请用 `key` 重新挂载，未保存的修改会先被保存。 */
  id: string;
  /** 关闭面板。 */
  onClose: () => void;
};

/** [`Segmented`] 的 Props。 */
type SegmentedProps<T extends string> = {
  /** 无障碍名称。 */
  label: string;
  /** 选项。 */
  options: readonly T[];
  /** 当前值。 */
  value: T;
  /** 选项的展示文案。 */
  render: (option: T) => string;
  /** 选中某项。 */
  onChange: (option: T) => void;
};

/**
 * 分段选择：几个互斥的按钮，当前项高亮（`aria-pressed`）。
 *
 * @param props 选项与回调。
 * @returns 分段控件。
 */
function Segmented<T extends string>({
  label,
  options,
  value,
  render,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex rounded-md border border-border bg-bg p-0.5"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className={cx(
            "h-7 flex-1 rounded-sm px-2 text-xs transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
            option === value
              ? "bg-primary font-medium text-primary-contrast"
              : "text-muted hover:bg-surface-hover hover:text-text",
          )}
        >
          {render(option)}
        </button>
      ))}
    </div>
  );
}

/** [`Field`] 的 Props。 */
type FieldProps = {
  /** 字段名。 */
  label: string;
  /** 控件。 */
  children: React.ReactNode;
};

/**
 * 带标签的表单字段。
 *
 * @param props 标签与控件。
 * @returns 字段元素。
 */
function Field({ label, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </div>
  );
}

/**
 * Item 详情面板（实施计划 3.1）：标题、描述（Markdown 纯文本）、类型、计划 / 截止日期、优先级与来源。
 *
 * * **自动保存**：停止输入 [`AUTOSAVE_DELAY_MS`] 毫秒后保存，只发送真正变化的字段；
 *   关闭面板或切换条目时先把未保存的修改保存掉；
 * * **保存失败不丢内容**：失败时修改仍保留在表单里，面板顶部显示原因与「重试」，
 *   继续编辑也会再次尝试；
 * * 类型转换由后端按领域规则清理不再适用的字段（离开 Todo 清除优先级 / 截止日期等），
 *   前端只在对应类型下显示这些字段；
 * * Esc 关闭。
 *
 * @param props 条目 ID 与关闭回调。
 * @returns 详情面板。
 */
export function ItemDetailPanel({ id, onClose }: ItemDetailPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const detailKey = queryKeys.itemDetail(id);
  const query = useQuery({
    queryKey: detailKey,
    queryFn: () => ipc.getItemDetail(id),
    staleTime: 0,
  });
  const item = query.data?.item;

  /** 尚未保存的修改（覆盖在后端数据之上）。 */
  const [edits, setEdits] = useState<Partial<ItemDraft>>({});
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const draft: ItemDraft | null = item === undefined ? null : { ...toDraft(item), ...edits };
  const patch = item === undefined || draft === null ? null : buildPatch(item, draft);

  /** 最新的 Item 与草稿，供异步保存与卸载时的保存读取（避免闭包里拿到过期值）。 */
  const latestRef = useRef<{ item: typeof item; draft: ItemDraft | null }>({ item, draft });
  const savingRef = useRef(false);
  useEffect(() => {
    latestRef.current = { item, draft };
  });

  /** 保存：发送相对后端数据的差异；成功后去掉已保存的字段，失败时保留一切并说明原因。 */
  async function save(): Promise<void> {
    const { item: current, draft: sent } = latestRef.current;
    if (current === undefined || sent === null || savingRef.current) return;
    const request = buildPatch(current, sent);
    if (request === null) return;
    savingRef.current = true;
    setStatus("saving");
    try {
      const saved = await ipc.updateItem(id, request);
      queryClient.setQueryData<InboxEntryDto>(detailKey, (old) =>
        old === undefined ? old : { ...old, item: saved },
      );
      setEdits((previous) => dropSaved(previous, sent));
      setStatus("saved");
      setProblem(null);
    } catch (error) {
      setStatus("error");
      setProblem(errorMessage(toAppError(error)));
    } finally {
      savingRef.current = false;
    }
  }
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  // 停止输入一会儿之后自动保存；每次差异变化都重新计时。
  const patchKey = JSON.stringify(patch);
  useEffect(() => {
    if (patchKey === "null") return;
    const timer = setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [patchKey]);

  // 卸载（关闭面板 / 切换条目）时把还没保存的修改保存掉。
  useEffect(
    () => () => {
      void saveRef.current();
    },
    [],
  );

  /**
   * 修改一个字段。
   *
   * @param change 要覆盖的字段。
   */
  function edit(change: Partial<ItemDraft>): void {
    setEdits((previous) => ({ ...previous, ...change }));
    if (status === "saved" || status === "error") setStatus("idle");
  }

  /**
   * Esc 关闭面板（在输入框里也一样：自动保存会在卸载时完成）。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }

  /** 打开来源；失败（文件已不存在等）统一提示。 */
  function openSource(): void {
    ipc.openItemSource(id).catch(reportError);
  }

  const kind = draft?.itemType ?? "todo";
  return (
    <aside
      aria-label={t("detail.label")}
      onKeyDown={handleKeyDown}
      className="flex h-full w-[24rem] shrink-0 flex-col border-l border-border bg-surface"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text">{t("detail.title")}</h2>
        <div className="flex items-center gap-2">
          <span role="status" className="text-xs text-muted">
            {status === "saving" && t("detail.status.saving")}
            {status === "saved" && t("detail.status.saved")}
          </span>
          <Button size="sm" variant="ghost" aria-label={t("detail.close")} onClick={onClose}>
            {"✕"}
          </Button>
        </div>
      </header>
      {query.isError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-muted">{errorMessage(toAppError(query.error))}</p>
          <Button size="sm" onClick={onClose}>
            {t("detail.close")}
          </Button>
        </div>
      ) : draft === null || item === undefined || query.data === undefined ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          {t("detail.loading")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {status === "error" && problem !== null && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-text"
            >
              <p>{t("detail.saveFailed", { reason: problem })}</p>
              <div>
                <Button size="sm" onClick={() => void save()}>
                  {t("detail.retry")}
                </Button>
              </div>
            </div>
          )}
          <Field label={t("detail.field.type")}>
            <Segmented
              label={t("detail.field.type")}
              options={TYPES}
              value={draft.itemType}
              render={(option) => t(`quickCreate.kind.${option}`)}
              onChange={(option) => edit({ itemType: option })}
            />
          </Field>
          <Field label={t("detail.field.title")}>
            <Input
              aria-label={t("detail.field.title")}
              value={draft.title}
              onChange={(event) => edit({ title: event.target.value })}
            />
          </Field>
          <Field label={t("detail.field.content")}>
            <Textarea
              aria-label={t("detail.field.content")}
              placeholder={t("detail.contentPlaceholder")}
              value={draft.content}
              rows={8}
              onChange={(event) => edit({ content: event.target.value })}
              className="resize-y font-mono text-[13px] leading-relaxed"
            />
            <Segmented
              label={t("detail.field.format")}
              options={FORMATS}
              value={draft.contentFormat}
              render={(option) => t(`detail.format.${option}`)}
              onChange={(option) => edit({ contentFormat: option })}
            />
          </Field>
          <Field label={t("detail.field.scheduled")}>
            <div className="flex gap-2">
              <Input
                type="date"
                aria-label={t("detail.field.scheduledDate")}
                value={draft.scheduledDate}
                onChange={(event) => edit({ scheduledDate: event.target.value })}
                className="min-w-0 flex-1"
              />
              <Input
                type="time"
                aria-label={t("detail.field.scheduledTime")}
                value={draft.scheduledTime}
                disabled={draft.scheduledDate === ""}
                onChange={(event) => edit({ scheduledTime: event.target.value })}
                className="w-24 shrink-0"
              />
            </div>
          </Field>
          {kind === "todo" && (
            <>
              <Field label={t("detail.field.due")}>
                <div className="flex gap-2">
                  <Input
                    type="date"
                    aria-label={t("detail.field.dueDate")}
                    value={draft.dueDate}
                    onChange={(event) => edit({ dueDate: event.target.value })}
                    className="min-w-0 flex-1"
                  />
                  <Input
                    type="time"
                    aria-label={t("detail.field.dueTime")}
                    value={draft.dueTime}
                    disabled={draft.dueDate === ""}
                    onChange={(event) => edit({ dueTime: event.target.value })}
                    className="w-24 shrink-0"
                  />
                </div>
              </Field>
              <Field label={t("detail.field.priority")}>
                <Segmented
                  label={t("detail.field.priority")}
                  options={PRIORITIES}
                  value={draft.priority}
                  render={(option) => t(`detail.priority.${option}`)}
                  onChange={(option) => edit({ priority: option })}
                />
              </Field>
            </>
          )}
          <SourceSection detail={query.data} onOpen={openSource} />
        </div>
      )}
    </aside>
  );
}
