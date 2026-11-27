import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Switch, Tooltip, LoadFeedback } from "@/components";
import { LAYOUT, useContainerWidth } from "@/lib/layout";
import { useNavStore } from "@/features/shell";
import { moveFocusWithArrows } from "@/lib/arrow-focus";
import { isCommandKey, isDialogOpen } from "@/lib/typing";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import type { WorkflowDto, WorkflowImportPreviewDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { toAppError } from "@/lib/errors";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";
import { ImportPreviewPanel } from "./ImportPreviewPanel";
import { WorkflowEditor } from "./WorkflowEditor";
import { RunInspector } from "./RunInspector";
import { workflowText } from "./model/builtin-text";
import { blankDefinition, freshId, stringify } from "./model/definition";

/** 页面里的两个标签页。 */
type Tab = "rules" | "runs";

/** [`WorkflowRow`] 的 Props。 */
type WorkflowRowProps = {
  /** 这一行的 Workflow。 */
  workflow: WorkflowDto;
  /** 是否是正在编辑的那个。 */
  selected: boolean;
  /** 选中。 */
  onSelect: () => void;
  /** 启用 / 禁用。 */
  onToggle: (enabled: boolean) => void;
  /** 调整优先级（增量）。 */
  onPriority: (delta: number) => void;
};

/**
 * 列表里的一行：启用开关、名称与说明、优先级调整。
 *
 * @param props 行的数据与回调。
 * @returns 列表项。
 */
function WorkflowRow({ workflow, selected, onSelect, onToggle, onPriority }: WorkflowRowProps) {
  const { t } = useTranslation();
  const { name, description } = workflowText(workflow);
  return (
    <li
      className={cx(
        "flex items-center gap-3 rounded-md px-2 py-2.5",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        selected ? "bg-surface-hover" : "hover:bg-surface-hover",
      )}
    >
      <div className="flex shrink-0 flex-col items-center gap-1">
        <Switch
          label={t("workflows.enable", { name })}
          checked={workflow.enabled}
          onCheckedChange={onToggle}
        />
        <span className="text-xs text-muted">
          {t(workflow.enabled ? "workflows.enabledState" : "workflows.disabledState")}
        </span>
      </div>
      <Tooltip content={description === "" ? name : `${name} — ${description}`}>
        <button
          type="button"
          data-workflow-item=""
          aria-current={selected ? "true" : undefined}
          onClick={onSelect}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block text-sm font-medium wrap-anywhere text-text">{name}</span>
          <span className="mt-1 line-clamp-2 text-xs wrap-anywhere text-muted">{description}</span>
        </button>
      </Tooltip>
      <div
        role="group"
        aria-label={t("workflows.priorityOf", { name })}
        className="flex shrink-0 items-center gap-1"
      >
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("workflows.priorityDown", { name })}
          onClick={() => onPriority(-1)}
        >
          {"−"}
        </Button>
        <span className="w-6 text-center text-sm tabular-nums text-text">{workflow.priority}</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("workflows.priorityUp", { name })}
          onClick={() => onPriority(1)}
        >
          {"+"}
        </Button>
      </div>
    </li>
  );
}

/**
 * Workflow 管理页（实施计划 5.7）：
 *
 * * 规则：内置与我的 Workflow 分组，启用开关、优先级调整、点开编辑 / 查看；
 * * 内置的只读，「复制」得到可自定义的副本，副本优先级更高，所以会先于原件生效；
 * * 最近执行：简单的 Run Inspector。
 *
 * @returns 页面。
 */
export function WorkflowsPage() {
  const rootRef = useRef<HTMLElement>(null);
  const compact = useContainerWidth(rootRef) < LAYOUT.stackedWorkspace;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("rules");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDto | null>(null);
  /** 正在确认的导入预览；非空时右侧显示预览面板。 */
  const [importPreview, setImportPreview] = useState<WorkflowImportPreviewDto | null>(null);
  /** 每次保存 / 复制后递增，让编辑区用最新的定义重新开始。 */
  const [generation, setGeneration] = useState(0);
  /** 编辑区有没有没保存的修改（编辑区上报）。 */
  const unsaved = useRef(false);
  /** 有没保存的修改时被拦下的那个操作：用户选「放弃修改」后才执行。 */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const trackDirty = useCallback((dirty: boolean) => {
    unsaved.current = dirty;
    // 修改都撤回了（或已保存）时，之前的提醒也不再需要。
    if (!dirty) {
      setPendingLeave(null);
      useNavStore.getState().cancelLeave();
    }
  }, []);
  // 换到别的视图（侧栏、Ctrl+1…5、Ctrl+K）也一样先提醒。
  const pendingNav = useNavStore((state) => state.pendingNav);
  useEffect(() => {
    const { setLeaveGuard } = useNavStore.getState();
    setLeaveGuard(() => unsaved.current);
    return () => setLeaveGuard(null);
  }, []);

  /**
   * 换走编辑区之前的检查：有没保存的修改时先提醒，不直接丢掉。
   *
   * @param action 要执行的操作（切换规则、新建、导入、切到「最近执行」）。
   */
  function leaveEditor(action: () => void): void {
    if (unsaved.current) {
      setPendingLeave(() => action);
      return;
    }
    action();
  }
  const workflows = useQuery({
    queryKey: queryKeys.workflows(),
    queryFn: () => ipc.listWorkflows(),
    staleTime: Infinity,
  });
  const all = workflows.data ?? [];
  const builtin = all.filter((w) => w.source === "builtin");
  const mine = all.filter((w) => w.source !== "builtin");
  const selected = draft ?? all.find((w) => w.id === selectedId) ?? null;

  /** 重新读取列表。 */
  function refresh(): Promise<void> {
    return queryClient.invalidateQueries({ queryKey: queryKeys.workflows() });
  }

  /**
   * 启用 / 禁用。
   *
   * @param workflow 目标。
   * @param enabled 新状态。
   */
  function toggle(workflow: WorkflowDto, enabled: boolean): void {
    ipc.setWorkflowEnabled(workflow.id, enabled).then(refresh).catch(reportError);
  }

  /**
   * 调整优先级。
   *
   * @param workflow 目标。
   * @param delta 增量。
   */
  function changePriority(workflow: WorkflowDto, delta: number): void {
    ipc
      .setWorkflowPriority(workflow.id, workflow.priority + delta)
      .then(refresh)
      .catch(reportError);
  }

  /** 选一个 Workflow 文件，校验后显示导入预览；取消选择什么都不发生。 */
  function startImport(): void {
    ipc
      .pickWorkflowImport()
      .then((preview) => {
        if (preview === null) return;
        setDraft(null);
        setSelectedId(null);
        setImportPreview(preview);
        setTab("rules");
      })
      .catch((failure: unknown) => {
        // 定义不合法（含「需要升级StarAt」）时，把后端说明原样告诉用户；其他错误走通用提示。
        const app = toAppError(failure);
        if (app.code === "WORKFLOW_INVALID") useToastStore.getState().push("error", app.message);
        else reportError(failure);
      });
  }

  /** 新建一个草稿（保存之前不会写入）。 */
  function create(): void {
    const id = freshId(all.map((w) => w.id));
    const definition = blankDefinition(id);
    setDraft({
      id,
      name: String(definition.name),
      description: "",
      source: "user",
      enabled: true,
      priority: 10,
      version: 1,
      readOnly: false,
      definitionJson: stringify(definition),
      updatedAt: "",
      scriptStatus: "none",
      scriptHosts: [],
    });
    setSelectedId(null);
    setTab("rules");
  }

  // Ctrl+N（macOS ⌘N）新建规则（有没保存的修改时先提醒），与「今天」「笔记」一致；有对话框打开时不响应。
  useEffect(() => {
    /**
     * 「新建」快捷键。
     *
     * @param event 键盘事件。
     */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (!isCommandKey(event, "n") || isDialogOpen()) return;
      event.preventDefault();
      leaveEditor(create);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  /**
   * 保存 / 复制之后：刷新列表并选中结果。
   *
   * @param next 结果。
   * @param message 提示文案。
   */
  function opened(next: WorkflowDto, message: string): void {
    setDraft(null);
    setSelectedId(next.id);
    setGeneration((n) => n + 1);
    useToastStore.getState().push("success", message);
    void refresh();
  }

  return (
    <section
      ref={rootRef}
      aria-label={t("workflows.label")}
      className="flex h-full min-w-0 flex-col"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-lg font-semibold text-text">{t("shell.nav.workflows")}</h1>
          <div role="tablist" aria-label={t("workflows.tabs")} className="flex gap-1">
            {(["rules", "runs"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                onClick={() => (item === tab ? undefined : leaveEditor(() => setTab(item)))}
                className={cx(
                  "rounded-md px-3 py-1 text-sm",
                  "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
                  tab === item
                    ? "bg-surface-hover font-medium text-text"
                    : "text-muted hover:text-text",
                )}
              >
                {t(`workflows.tab.${item}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => leaveEditor(startImport)}>
            {t("workflows.import.button")}
          </Button>
          <Button size="sm" onClick={() => leaveEditor(create)}>
            {t("workflows.new")}
          </Button>
        </div>
      </header>
      {(pendingLeave !== null || pendingNav !== null) && (
        <div
          role="alert"
          className="mx-6 mt-3 flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-text"
        >
          <p>{t("workflows.leave.message")}</p>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              onClick={() => {
                setPendingLeave(null);
                useNavStore.getState().cancelLeave();
              }}
            >
              {t("workflows.leave.keep")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              onClick={() => {
                const action = pendingLeave;
                unsaved.current = false;
                setPendingLeave(null);
                if (action !== null) action();
                else useNavStore.getState().confirmLeave();
              }}
            >
              {t("workflows.leave.discard")}
            </Button>
          </div>
        </div>
      )}
      {tab === "runs" ? (
        <RunInspector />
      ) : (
        <div
          className={cx(
            "grid min-h-0 flex-1",
            compact
              ? "grid-cols-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)]"
              : selected === null && importPreview === null
                ? "grid-cols-1 grid-rows-[minmax(0,1fr)_auto]"
                : "grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)]",
          )}
        >
          <div
            className="min-h-0 overflow-y-auto border-r border-border px-3 py-3"
            // ↑ / ↓ 在规则之间移动（跨过「内置 / 我的」分组），Enter 打开；不自动打开，免得丢掉正在编辑的内容。
            onKeyDown={(event) => moveFocusWithArrows(event, "[data-workflow-item]")}
          >
            <p className="px-2 pb-3 text-xs text-muted">{t("workflows.intro")}</p>
            <LoadFeedback
              loading={workflows.isLoading}
              failed={workflows.isError}
              onRetry={() => void workflows.refetch()}
            />
            {workflows.data !== undefined &&
              [
                { key: "builtin", rows: builtin },
                { key: "mine", rows: mine },
              ].map((group) => (
                <div key={group.key} className="mb-4">
                  <h2 className="px-2 pb-1 text-xs font-medium text-muted">
                    {t(`workflows.group.${group.key}`)}
                  </h2>
                  {group.rows.length === 0 ? (
                    <p className="px-2 py-2 text-sm text-muted">{t("workflows.groupEmpty")}</p>
                  ) : (
                    <ul aria-label={t(`workflows.group.${group.key}`)}>
                      {group.rows.map((workflow) => (
                        <WorkflowRow
                          key={workflow.id}
                          workflow={workflow}
                          selected={selected?.id === workflow.id}
                          onSelect={() =>
                            leaveEditor(() => {
                              setDraft(null);
                              setSelectedId(workflow.id);
                            })
                          }
                          onToggle={(enabled) => toggle(workflow, enabled)}
                          onPriority={(delta) => changePriority(workflow, delta)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              ))}
          </div>
          <div className="min-h-0 min-w-0">
            {importPreview !== null ? (
              <ImportPreviewPanel
                preview={importPreview}
                onCancel={() => setImportPreview(null)}
                onImported={(imported) => {
                  setImportPreview(null);
                  opened(imported, t("workflows.import.done", { name: imported.name }));
                }}
              />
            ) : selected === null ? (
              workflows.data === undefined ? null : (
                <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-3 text-center">
                  <p className="text-base font-medium text-text">{t("workflows.pickTitle")}</p>
                  <p className="max-w-sm text-sm text-muted">{t("workflows.pickHint")}</p>
                </div>
              )
            ) : (
              <WorkflowEditor
                key={`${selected.id}:${generation}`}
                workflow={selected}
                isNew={draft !== null}
                onDirtyChange={trackDirty}
                onSaved={(saved) => opened(saved, t("workflows.saved", { name: saved.name }))}
                onConfirmed={() => {
                  setGeneration((n) => n + 1);
                  void refresh();
                }}
                onDuplicated={(copy) =>
                  opened(copy, t("workflows.duplicated", { name: copy.name }))
                }
                onDeleted={() => {
                  setSelectedId(null);
                  useToastStore.getState().push("success", t("workflows.deleted"));
                  void refresh();
                }}
                onClose={() => {
                  setDraft(null);
                  setSelectedId(null);
                }}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
