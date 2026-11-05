import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, Input, Textarea } from "@/components";
import { ProjectSelect } from "@/features/organize";
import { reminderToUtc } from "@/features/detail";
import { trapTab } from "@/lib/focus-trap";
import { ipc } from "@/lib/ipc";
import type { ContentFormatDto, ItemTypeDto, PriorityDto } from "@/lib/ipc";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import { reportError } from "@/lib/report-error";
import { QUICK_CREATE_KINDS, cycleKind } from "./model/quick-create";

/** 完整新增页的入口类型、默认日期与关闭回调。 */
type CreateConfigurationProps = {
  /** 从哪个新增入口打开。 */
  kind: ItemTypeDto;
  /** 后端提供的本地今天。 */
  today?: string | undefined;
  /** 创建成功或明确取消后恢复悬浮框。 */
  onDone: () => void;
  /** 文件或图片粘贴沿用收集箱捕获，保留当前草稿。 */
  onPasteNonText?: (() => void) | undefined;
  /** 收集结果及撤销，不覆盖底栏。 */
  feedback?: ReactNode;
  /** 已打开时再次请求新增（托盘、全局快捷键）递增此值：重新取回焦点，不清空草稿。 */
  focusRequest?: number;
};

/** 一次新增的全部可编辑字段。 */
type Draft = {
  kind: ItemTypeDto;
  title: string;
  brief: string;
  content: string;
  format: ContentFormatDto;
  scheduledDate: string;
  scheduledTime: string;
  dueDate: string;
  dueTime: string;
  reminder: string;
  priority: PriorityDto;
  projectId: string;
};

/** 与后端 `MAX_TITLE_CHARS` 一致，避免输入超长后才在保存时报错。 */
const MAX_TITLE_CHARS = 500;

/** 本次悬浮窗运行期间记住「连续新增」的选择，下次打开沿用。 */
let keepOpenPreference = false;

/** 某类型的空白草稿：待办与提示默认安排在今天，笔记不安排。 */
function blankDraft(kind: ItemTypeDto, today: string | undefined): Draft {
  return {
    kind,
    title: "",
    brief: "",
    content: "",
    format: "plain",
    scheduledDate: kind === "note" ? "" : (today ?? ""),
    scheduledTime: "",
    dueDate: "",
    dueTime: "",
    reminder: "",
    priority: "none",
    projectId: "",
  };
}

/** 草稿是否与基线不同（基线是打开时或上一次连续创建后的状态）。 */
function differs(draft: Draft, baseline: Draft): boolean {
  return (Object.keys(draft) as (keyof Draft)[]).some((key) => draft[key] !== baseline[key]);
}

/** 带可见标签的字段组，原生控件仍有自己的可访问名称。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-sm font-medium text-text">{label}</span>
      {children}
    </div>
  );
}

/** 在原生居中窗口中填写完整信息；只有明确创建时才写入。 */
export function CreateConfiguration({
  kind: initialKind,
  today,
  onDone,
  onPasteNonText,
  feedback,
  focusRequest = 0,
}: CreateConfigurationProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState(() => blankDraft(initialKind, today));
  const baseline = useRef(draft);
  /** 用户亲自改过计划日期后，默认日期不再覆盖它。 */
  const dateTouched = useRef(false);
  const [keepOpen, setKeepOpen] = useState(keepOpenPreference);
  const [lastCreated, setLastCreated] = useState<string | null>(null);
  const {
    kind,
    title,
    brief,
    content,
    format,
    scheduledDate,
    scheduledTime,
    dueDate,
    dueTime,
    reminder,
    priority,
    projectId,
  } = draft;
  /** 修改草稿的部分字段。 */
  const patch = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }));
  const [ready, setReady] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  const keepOpenRef = useRef(keepOpen);
  useEffect(() => {
    keepOpenRef.current = keepOpen;
    keepOpenPreference = keepOpen;
  }, [keepOpen]);

  // 今天的日期可能在页面打开之后才取到：未改动的计划日期与比较基线一起补上，避免空白草稿被误判为已修改。
  useEffect(() => {
    if (today === undefined || dateTouched.current) return;
    /** 计划日期仍为空的待办 / 提示补上今天。 */
    const fill = (current: Draft) =>
      current.kind === "note" || current.scheduledDate !== ""
        ? current
        : { ...current, scheduledDate: today };
    baseline.current = fill(baseline.current);
    setDraft(fill);
  }, [today]);

  const create = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: ({
      kind,
      title,
      brief,
      content,
      format,
      scheduledDate,
      scheduledTime,
      dueDate,
      dueTime,
      reminder,
      priority,
      projectId,
    }: Draft) =>
      ipc.createItem({
        itemType: kind,
        title: title.trim(),
        brief: kind === "note" ? null : brief.trim() || null,
        content: content.trim() === "" ? null : content,
        contentFormat: format,
        priority: kind === "todo" ? priority : "none",
        scheduled:
          kind === "note" || scheduledDate === ""
            ? null
            : { date: scheduledDate, time: scheduledTime || null },
        due: kind !== "todo" || dueDate === "" ? null : { date: dueDate, time: dueTime || null },
        reminderAt: kind === "note" || reminder === "" ? null : reminderToUtc(reminder),
        projectId: projectId || null,
      }),
    onSuccess: (_item, sent) => {
      if (!keepOpenRef.current) {
        onDoneRef.current();
        return;
      }
      // 连续新增：保留类型、日期、格式和项目，清空内容，便于接着录入同一批事项。
      const next: Draft = {
        ...blankDraft(sent.kind, today),
        format: sent.format,
        scheduledDate: sent.kind === "note" ? "" : sent.scheduledDate,
        projectId: sent.projectId,
      };
      baseline.current = next;
      setDraft(next);
      setLastCreated(sent.title.trim());
    },
    onSettled: () => {
      submitting.current = false;
    },
  });

  useEffect(() => {
    let cancelled = false;
    ipc
      .beginFloatingInput(true)
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        reportError(error);
        onDoneRef.current();
      });
    return () => {
      cancelled = true;
      ipc.endFloatingInput().catch(reportError);
    };
  }, []);
  useEffect(() => {
    if (ready && !confirmDiscard) inputRef.current?.focus();
  }, [ready, confirmDiscard]);
  useEffect(() => {
    if (confirmDiscard) keepRef.current?.focus();
  }, [confirmDiscard]);
  // 连续新增后字段组随保存结束重新启用，此时才能把焦点放回标题。
  useEffect(() => {
    if (ready && !create.isPending && lastCreated !== null) inputRef.current?.focus();
  }, [ready, create.isPending, lastCreated]);

  // 页面已打开时再次请求新增：用户可能已切到别的应用，重新取得原生焦点并回到当前草稿。
  const handledFocusRequest = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === handledFocusRequest.current) return;
    handledFocusRequest.current = focusRequest;
    /** 放弃确认打开时聚焦「继续编辑」，否则回到标题。 */
    const focusDraft = () => (confirmDiscard ? keepRef : inputRef).current?.focus();
    if (document.hasFocus()) focusDraft();
    else ipc.beginFloatingInput(true).then(focusDraft).catch(reportError);
  }, [focusRequest, confirmDiscard]);

  /** 切换类型；计划日期未被改过时按新类型补上默认值。 */
  function changeKind(next: ItemTypeDto): void {
    setDraft((current) => ({
      ...current,
      kind: next,
      scheduledDate:
        !dateTouched.current && next !== "note" && current.scheduledDate === ""
          ? (today ?? "")
          : current.scheduledDate,
    }));
  }

  /** 取消只有空白草稿直接关闭，其余先给用户保留输入的机会。 */
  function cancel(): void {
    if (submitting.current) return;
    if (differs(draft, baseline.current)) setConfirmDiscard(true);
    else onDone();
  }

  /** 在当前草稿上发起一次完整创建，失败后保留输入。 */
  function submit(): void {
    if (!ready || submitting.current || confirmDiscard || title.trim() === "") return;
    if (kind !== "note" && reminder !== "" && reminderToUtc(reminder) === null) {
      setProblem(t("detail.incompleteReminder"));
      return;
    }
    if (!formRef.current?.reportValidity()) return;
    setProblem(null);
    submitting.current = true;
    create.mutate(draft);
  }

  return (
    <form
      ref={formRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={hintId}
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl bg-surface text-text shadow-lg"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        trapTab(event, event.currentTarget);
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (confirmDiscard) {
            setConfirmDiscard(false);
            inputRef.current?.focus();
          } else cancel();
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          submit();
        } else if (event.key === "Enter" && event.target instanceof HTMLInputElement)
          event.preventDefault();
      }}
    >
      <header className="shrink-0 border-b border-border px-6 py-4">
        <h1 id={headingId} className="text-xl font-semibold">
          {t("createConfiguration.title")}
        </h1>
        <p id={hintId} className="mt-1 text-sm text-muted">
          {t("createConfiguration.hint")}
        </p>
      </header>
      <fieldset
        disabled={!ready || create.isPending || confirmDiscard}
        className="min-h-0 flex-1 overflow-y-auto border-0 p-6"
      >
        <div className="flex flex-col gap-5">
          <div
            role="radiogroup"
            aria-label={t("quickCreate.typeLabel")}
            className="flex flex-wrap gap-2"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (
                !["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"].includes(
                  event.key,
                )
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "todo"
                  : event.key === "End"
                    ? "tip"
                    : cycleKind(kind, event.key === "ArrowLeft" || event.key === "ArrowUp");
              changeKind(next);
              event.currentTarget.querySelector<HTMLElement>(`[data-kind="${next}"]`)?.focus();
            }}
          >
            {QUICK_CREATE_KINDS.map((option) => (
              <Button
                key={option}
                role="radio"
                aria-checked={kind === option}
                tabIndex={kind === option ? 0 : -1}
                data-kind={option}
                variant={kind === option ? "primary" : "secondary"}
                onClick={() => changeKind(option)}
              >
                {t(`quickCreate.kind.${option}`)}
              </Button>
            ))}
          </div>
          <Field label={t("createConfiguration.titleLabel")}>
            <Input
              ref={inputRef}
              aria-label={t("detail.field.title")}
              value={title}
              required
              placeholder={t("createConfiguration.titlePlaceholder")}
              maxLength={MAX_TITLE_CHARS}
              onChange={(event) => {
                patch({ title: event.target.value });
                setLastCreated(null);
              }}
              onPaste={(event) => {
                if (onPasteNonText && !event.clipboardData.getData("text/plain")) {
                  event.preventDefault();
                  onPasteNonText();
                }
              }}
            />
          </Field>
          {kind !== "note" && (
            <Field label={t("detail.field.brief")}>
              <Input
                aria-label={t("detail.field.brief")}
                value={brief}
                placeholder={t("detail.briefPlaceholder")}
                onChange={(event) => patch({ brief: event.target.value })}
              />
            </Field>
          )}
          <Field label={t("detail.field.content")}>
            <Textarea
              aria-label={t("detail.field.content")}
              value={content}
              rows={4}
              placeholder={t("createConfiguration.contentPlaceholder")}
              onChange={(event) => patch({ content: event.target.value })}
            />
          </Field>
          <Field label={t("detail.field.format")}>
            <select
              aria-label={t("detail.field.format")}
              className="h-9 rounded-md border border-border bg-surface px-3 text-sm"
              value={format}
              onChange={(event) =>
                patch({ format: event.target.value === "markdown" ? "markdown" : "plain" })
              }
            >
              <option value="plain">{t("detail.format.plain")}</option>
              <option value="markdown">{t("detail.format.markdown")}</option>
            </select>
          </Field>
          {kind !== "note" && (
            <section
              className="border-t border-border pt-5"
              aria-label={t("createConfiguration.schedule")}
            >
              <h2 className="mb-4 text-base font-semibold">{t("createConfiguration.schedule")}</h2>
              <div className="grid grid-cols-1 gap-4 min-[460px]:grid-cols-2">
                <Field label={t("detail.field.scheduled")}>
                  <Input
                    type="date"
                    aria-label={t("detail.field.scheduledDate")}
                    value={scheduledDate}
                    onChange={(event) => {
                      dateTouched.current = true;
                      patch(
                        event.target.value
                          ? { scheduledDate: event.target.value }
                          : { scheduledDate: "", scheduledTime: "" },
                      );
                    }}
                  />
                </Field>
                <Field label={t("detail.field.scheduledTime")}>
                  <Input
                    type="time"
                    aria-label={t("detail.field.scheduledTime")}
                    value={scheduledTime}
                    disabled={!scheduledDate}
                    onChange={(event) => patch({ scheduledTime: event.target.value })}
                  />
                </Field>
                {kind === "todo" && (
                  <>
                    <Field label={t("detail.field.due")}>
                      <Input
                        type="date"
                        aria-label={t("detail.field.dueDate")}
                        value={dueDate}
                        onChange={(event) => {
                          patch(
                            event.target.value
                              ? { dueDate: event.target.value }
                              : { dueDate: "", dueTime: "" },
                          );
                        }}
                      />
                    </Field>
                    <Field label={t("detail.field.dueTime")}>
                      <Input
                        type="time"
                        aria-label={t("detail.field.dueTime")}
                        value={dueTime}
                        disabled={!dueDate}
                        onChange={(event) => patch({ dueTime: event.target.value })}
                      />
                    </Field>
                  </>
                )}
                <div className="min-w-0 min-[460px]:col-span-2">
                  <Field label={t("detail.field.reminder")}>
                    <Input
                      type="datetime-local"
                      aria-label={t("detail.reminder.input")}
                      value={reminder}
                      onChange={(event) => patch({ reminder: event.target.value })}
                    />
                    <p className="text-xs text-muted">{t("detail.reminder.hint")}</p>
                  </Field>
                </div>
              </div>
            </section>
          )}
          <section
            className="border-t border-border pt-5"
            aria-label={t("createConfiguration.organize")}
          >
            <h2 className="mb-4 text-base font-semibold">{t("createConfiguration.organize")}</h2>
            <div className="grid grid-cols-1 gap-4 min-[460px]:grid-cols-2">
              <Field label={t("detail.field.project")}>
                <ProjectSelect
                  value={projectId}
                  onChange={(value) => patch({ projectId: value })}
                />
              </Field>
              {kind === "todo" && (
                <Field label={t("detail.field.priority")}>
                  <select
                    aria-label={t("detail.field.priority")}
                    className="h-9 rounded-md border border-border bg-surface px-3 text-sm"
                    value={priority}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (
                        value === "none" ||
                        value === "low" ||
                        value === "medium" ||
                        value === "high"
                      )
                        patch({ priority: value });
                    }}
                  >
                    {(["none", "low", "medium", "high"] as const).map((option) => (
                      <option key={option} value={option}>
                        {t(`detail.priority.${option}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          </section>
        </div>
      </fieldset>
      <footer className="flex shrink-0 flex-col gap-3 border-t border-border bg-bg px-6 py-4">
        {feedback}
        {lastCreated !== null && !create.isError && (
          <p role="status" className="text-sm text-muted">
            {t("createConfiguration.created", { title: lastCreated })}
          </p>
        )}
        {(create.isError || problem !== null) && (
          <p role="alert" className="text-sm text-danger">
            {problem ?? errorMessage(toAppError(create.error))}
          </p>
        )}
        {confirmDiscard ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-sm">{t("createConfiguration.discardPrompt")}</p>
            <Button
              ref={keepRef}
              onClick={() => {
                setConfirmDiscard(false);
                inputRef.current?.focus();
              }}
            >
              {t("createConfiguration.keepEditing")}
            </Button>
            <Button variant="danger" onClick={onDone}>
              {t("createConfiguration.discard")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="mr-auto flex flex-wrap items-center gap-x-4 gap-y-1">
              <Checkbox
                checked={keepOpen}
                onCheckedChange={setKeepOpen}
                label={t("createConfiguration.keepOpen")}
                disabled={create.isPending}
              />
              <span className="text-xs text-muted">{t("createConfiguration.shortcut")}</span>
            </div>
            {/* 两个操作一起换行，窄窗口里不会把取消和创建拆到两行。 */}
            <div className="ml-auto flex gap-2">
              <Button onClick={cancel} disabled={create.isPending}>
                {t("createConfiguration.cancel")}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!ready || create.isPending || !title.trim()}
              >
                {create.isPending
                  ? t("createConfiguration.creating")
                  : create.isError
                    ? t("createConfiguration.retry")
                    : t("createConfiguration.create")}
              </Button>
            </div>
          </div>
        )}
      </footer>
    </form>
  );
}
