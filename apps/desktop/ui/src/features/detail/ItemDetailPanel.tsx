import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, LiveMarkdownEditor, Textarea, Menu } from "@/components";
import { cx } from "@/lib/cx";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import type { ContentFormatDto, ItemTypeDto, PriorityDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { useToastStore } from "@/stores/toast-store";
import { reportError } from "@/lib/report-error";
import { ProjectSelect, TagsField } from "@/features/organize";
import { useDeleteItems } from "@/features/trash";
import { reminderPresets } from "./model/reminder-presets";
import { SourceSection } from "./SourceSection";
import { AttachmentsSection } from "./AttachmentsSection";
import { useItemDraft } from "./use-item-draft";
import { DraftRecovery } from "./DraftRecovery";
import { useDraftTransitionStore } from "@/stores/draft-transition-store";
import { trapTab } from "@/lib/focus-trap";

export { AUTOSAVE_DELAY_MS } from "./use-item-draft";

/** 类型选项，按展示顺序。 */
const TYPES: ItemTypeDto[] = ["todo", "note", "tip"];

/** 优先级选项，按展示顺序。 */
const PRIORITIES: PriorityDto[] = ["none", "low", "medium", "high"];

/** 内容格式选项。 */
const FORMATS: ContentFormatDto[] = ["plain", "markdown"];

/** [`ItemDetailPanel`] 的 Props。 */
export type ItemDetailPanelProps = {
  /** 要编辑的 Item。父级切换条目前必须经过草稿协调器，成功后才用新 `key` 挂载。 */
  id: string;
  /** 关闭面板。 */
  onClose: () => void;
  /** 窄窗口使用同一个编辑器实例作为模态侧页。 */
  modal?: boolean;
  /** 搜索等临时模态拥有焦点时暂停当前表面。 */
  suspended?: boolean;
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
 * Item 详情面板（实施计划 3.1）：标题、简述（Todo / Tip）、描述（Markdown 边写边渲染，或纯文本）、类型、计划 / 截止日期、优先级与来源。
 *
 * * **自动保存**：停止输入 [`AUTOSAVE_DELAY_MS`] 毫秒后保存，只发送真正变化的字段；
 *   关闭面板或切换条目时先把未保存的修改保存掉；
 * * **保存失败不丢内容**：失败时修改仍保留在表单里，面板顶部显示原因与「重试」，
 *   继续编辑也会再次尝试；
 * * 类型转换由后端按领域规则清理不再适用的字段（离开 Todo 清除优先级 / 截止日期等），
 *   前端只在对应类型下显示这些字段；
 * * 打开时焦点移进面板（键盘用户可以直接 Tab 到各字段、按 Esc 关闭），关闭时回到打开它的元素；
 * * Esc 关闭。
 *
 * @param props 条目 ID 与关闭回调。
 * @returns 详情面板。
 */
export function ItemDetailPanel({
  id,
  onClose,
  modal = false,
  suspended = false,
}: ItemDetailPanelProps) {
  const { t } = useTranslation();
  const { query, detail, draft, status, problem, owner, edit, save } = useItemDraft(id, 20);
  const item = detail?.item;
  const { remove } = useDeleteItems();
  const panelRef = useRef<HTMLElement>(null);
  const openedFrom = useRef(document.activeElement);
  const titleRef = useRef<HTMLInputElement>(null);
  const contentId = useId();
  const [contentExpanded, setContentExpanded] = useState(false);
  /** 正常关闭必须等待草稿保存，失败则保留挂载。 */
  const close = (): void => useDraftTransitionStore.getState().request(onClose);

  // 从停靠转成模态或从搜索返回时，保留已有的输入焦点；焦点在背景时移入。
  useEffect(() => {
    const panel = panelRef.current;
    if (modal && !suspended && panel && !panel.contains(document.activeElement))
      panel.focus({ preventScroll: true });
  }, [modal, suspended]);

  // 打开时把焦点移进面板；关闭时还给打开它的那一行。焦点已经在面板里（如点了里面的字段）时不动；
  // 关闭时焦点已经去了别处（点了另一行），或那一行已经不在（删除了）时也不抢。
  useEffect(() => {
    const panel = panelRef.current;
    const opener = openedFrom.current;
    const row = opener instanceof Element ? opener.closest("li") : null;
    const neighbor =
      row?.nextElementSibling?.querySelector<HTMLElement>("button") ??
      row?.previousElementSibling?.querySelector<HTMLElement>("button");
    if (panel !== null && !panel.contains(opener)) panel.focus({ preventScroll: true });
    return () => {
      const current = document.activeElement;
      const lost =
        current === null || current === document.body || panel?.contains(current) === true;
      if (!lost) return;
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected)
        opener.focus();
      else if (neighbor?.isConnected) neighbor.focus();
      else {
        const heading = document.querySelector<HTMLElement>("main h1");
        if (heading) {
          heading.tabIndex = -1;
          heading.focus();
        }
      }
    };
  }, []);

  // 记下「打开过」，让搜索框空输入时的「最近使用」把它排在前面。只是排序提示，失败不打扰用户。
  useEffect(() => {
    ipc.markItemOpened(id).catch(() => undefined);
  }, [id]);

  /**
   * Esc 请求保存并关闭；失败保留当前面板。刚打开时的第一下 Tab 进到标题。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (
      event.defaultPrevented ||
      (event.target instanceof Element && event.target.closest('[role="menu"]'))
    )
      return;
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (
      event.key === "Tab" &&
      !event.shiftKey &&
      event.target === panelRef.current &&
      titleRef.current !== null
    ) {
      // 刚打开时焦点在面板本身：第一下 Tab 进到标题，而不是页首的「删除」，免得 Tab、Enter 误删。
      event.preventDefault();
      titleRef.current.focus();
    } else if (modal) {
      trapTab(event, panelRef.current);
    }
  }

  /** 打开来源；失败（文件已不存在等）统一提示。 */
  function openSource(): void {
    ipc.openItemSource(id).catch(reportError);
  }

  /** 重新运行这个条目的来源规则，并提示结果。 */
  function rerun(): void {
    ipc
      .rerunWorkflow(id)
      .then((changed) =>
        useToastStore
          .getState()
          .push("success", t(changed ? "detail.source.rerunDone" : "detail.source.rerunSame")),
      )
      .catch(reportError);
  }

  const kind = draft?.itemType ?? "todo";
  return (
    <>
      {modal && !suspended && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-(--nv-z-menu) bg-text/30"
          onMouseDown={close}
        />
      )}
      <aside
        ref={panelRef}
        tabIndex={-1}
        role={modal && !suspended ? "dialog" : "complementary"}
        aria-modal={modal && !suspended ? true : undefined}
        inert={suspended}
        aria-label={t("detail.label")}
        onKeyDown={handleKeyDown}
        className={cx(
          "nv-detail-panel flex min-h-0 flex-col border-l border-border bg-surface focus-visible:outline-none",
          modal ? "fixed inset-y-0 right-0 z-(--nv-z-dialog) shadow-lg" : "row-start-2 h-full",
          suspended && "invisible",
        )}
      >
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text">{t("detail.title")}</h2>
          <div className="flex items-center gap-2">
            <span role="status" className="text-xs text-muted">
              {status === "saving" && t("detail.status.saving")}
              {status === "saved" && t("detail.status.saved")}
              {status === "error" && t("detail.status.error")}
            </span>
            <Menu
              withinDialog={modal}
              trigger={
                <Button size="sm" variant="ghost">
                  {t("detail.more")}
                </Button>
              }
              items={[
                {
                  id: "delete",
                  label: t("trash.delete"),
                  isDanger: true,
                  isDisabled: item === undefined,
                  onSelect: () =>
                    useDraftTransitionStore.getState().request(() => {
                      if (item)
                        void remove([id], item.title).then((deleted) => {
                          if (deleted) onClose();
                        });
                    }),
                },
              ]}
            />
            <Button size="sm" variant="ghost" aria-label={t("detail.close")} onClick={close}>
              {"✕"}
            </Button>
          </div>
        </header>
        <DraftRecovery
          owner={owner}
          problem={problem}
          save={save}
          showBlocked={modal && !suspended}
          className="mx-4 mt-3 max-h-[40%] shrink-0 overflow-y-auto"
        />
        {query.isError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-muted">{errorMessage(toAppError(query.error))}</p>
            <Button size="sm" onClick={close}>
              {t("detail.close")}
            </Button>
          </div>
        ) : draft === null || item === undefined || query.data === undefined ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">
            {t("detail.loading")}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            <Field label={t("detail.field.title")}>
              <Input
                ref={titleRef}
                aria-label={t("detail.field.title")}
                value={draft.title}
                onChange={(event) => edit({ title: event.target.value })}
              />
            </Field>
            {kind !== "note" && (
              <Field label={t("detail.field.brief")}>
                <Input
                  aria-label={t("detail.field.brief")}
                  placeholder={t("detail.briefPlaceholder")}
                  value={draft.brief}
                  onChange={(event) => edit({ brief: event.target.value })}
                />
              </Field>
            )}
            <Field label={t("detail.field.scheduled")}>
              <p className="text-xs text-muted">{t("detail.scheduleHint")}</p>
              <div className="nv-detail-date flex gap-2">
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
                  <p className="text-xs text-muted">{t("detail.dueHint")}</p>
                  <div className="nv-detail-date flex gap-2">
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
              </>
            )}
            {kind !== "note" && (
              <Field label={t("detail.field.reminder")}>
                <Input
                  type="datetime-local"
                  aria-label={t("detail.reminder.input")}
                  value={draft.reminder}
                  onChange={(event) => edit({ reminder: event.target.value })}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  {reminderPresets(draft).map((preset) => {
                    const reason =
                      preset.value !== null
                        ? undefined
                        : preset.kind === "minutes15" || preset.kind === "hour1"
                          ? t("detail.reminder.needTime")
                          : t("detail.reminder.needDate");
                    return (
                      <Button
                        key={preset.kind}
                        size="sm"
                        variant={
                          preset.value !== null && preset.value === draft.reminder
                            ? "primary"
                            : "secondary"
                        }
                        disabled={preset.value === null}
                        title={reason}
                        onClick={() => preset.value !== null && edit({ reminder: preset.value })}
                      >
                        {t(`detail.reminder.preset.${preset.kind}`)}
                      </Button>
                    );
                  })}
                  {draft.reminder !== "" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("detail.reminder.clear")}
                      onClick={() => edit({ reminder: "" })}
                    >
                      {"✕"}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted">{t("detail.reminder.hint")}</p>
              </Field>
            )}
            <Field label={t("detail.field.project")}>
              <ProjectSelect
                value={draft.projectId}
                onChange={(projectId) => edit({ projectId })}
              />
            </Field>
            {kind === "todo" && (
              <Field label={t("detail.field.priority")}>
                <Segmented
                  label={t("detail.field.priority")}
                  options={PRIORITIES}
                  value={draft.priority}
                  render={(option) => t(`detail.priority.${option}`)}
                  onChange={(option) => edit({ priority: option })}
                />
              </Field>
            )}
            <Field label={t("detail.field.content")}>
              {draft.contentFormat === "markdown" ? (
                // 与笔记编辑区一样边写边渲染；Ctrl+B / I、列表续行与缩进也相同。
                <LiveMarkdownEditor
                  id={contentId}
                  variant="field"
                  rows={contentExpanded ? 12 : 3}
                  label={t("detail.field.content")}
                  placeholder={t("detail.contentPlaceholder")}
                  value={draft.content}
                  onChange={(content) => edit({ content })}
                />
              ) : (
                <Textarea
                  id={contentId}
                  aria-label={t("detail.field.content")}
                  placeholder={t("detail.contentPlaceholder")}
                  value={draft.content}
                  rows={contentExpanded ? 12 : 3}
                  onChange={(event) => edit({ content: event.target.value })}
                  className="resize-y font-mono text-[13px] leading-relaxed"
                />
              )}
              {!contentExpanded && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={false}
                  aria-controls={contentId}
                  onClick={() => {
                    setContentExpanded(true);
                    document.getElementById(contentId)?.focus({ preventScroll: true });
                  }}
                >
                  {t("detail.expandContent")}
                </Button>
              )}
              <Segmented
                label={t("detail.field.format")}
                options={FORMATS}
                value={draft.contentFormat}
                render={(option) => t(`detail.format.${option}`)}
                onChange={(option) => edit({ contentFormat: option })}
              />
            </Field>
            <Field label={t("detail.field.tags")}>
              <TagsField itemId={id} tags={query.data.tags} />
            </Field>
            <SourceSection detail={query.data} onOpen={openSource} onRerun={rerun} />
            <AttachmentsSection detail={query.data} />
            <Field label={t("detail.field.type")}>
              <Segmented
                label={t("detail.field.type")}
                options={TYPES}
                value={draft.itemType}
                render={(option) => t(`quickCreate.kind.${option}`)}
                onChange={(option) => edit({ itemType: option })}
              />
            </Field>
          </div>
        )}
      </aside>
    </>
  );
}
