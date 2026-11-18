import { isImeKey } from "@/lib/ime";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { ClipboardEvent, ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, Input, Textarea } from "@/components";
import type { TFunction } from "i18next";
import { linkKey, mergeLinks, shortUrl, textDraft, toLinkDtos } from "@/features/capture";
import type { DraftLink, DropDraft } from "@/features/capture";
import { ProjectSelect } from "@/features/organize";
import { reminderToUtc } from "@/features/detail";
import { trapTab } from "@/lib/focus-trap";
import { handleMarkdownKeyDown, handleMarkdownPaste } from "@/lib/markdown-keys";
import { ipc } from "@/lib/ipc";
import type {
  ContentFormatDto,
  ContextCreateRequestedEvent,
  ItemDto,
  ItemTypeDto,
  PriorityDto,
} from "@/lib/ipc";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import { reportError } from "@/lib/report-error";
import { QUICK_CREATE_KINDS, cycleKind } from "./model/quick-create";
import { parseDatePhrase } from "./model/date-phrase";

/** 完整新增页的入口类型、默认日期与关闭回调。 */
type CreateConfigurationProps = {
  /** 从哪个新增入口打开。 */
  kind: ItemTypeDto;
  /** 后端提供的本地今天。 */
  today?: string | undefined;
  /** 预填日历落点；用户仍可在表单内更改。 */
  targetDate?: string | undefined;
  /** 由主窗口对话框承载时，无需请求悬浮窗尺寸和焦点。 */
  embedded?: boolean;
  /** 日期入口明确请求导入时，显示弹窗后立即读取一次。 */
  importOnOpen?: boolean;
  /** 创建成功或明确取消后关闭表单。 */
  onDone: () => void;
  /** 提交成功后的反馈由承载窗口决定。 */
  onCreated?: (item: ItemDto) => void;
  /** 文件或图片粘贴沿用收集箱捕获，保留当前草稿。 */
  onPasteNonText?: (() => void) | undefined;
  /** 收集结果及撤销，不覆盖底栏。 */
  feedback?: ReactNode;
  /** 已打开时再次请求新增（托盘、全局快捷键）递增此值：重新取回焦点，不清空草稿。 */
  focusRequest?: number;
  /**
   * 拖入悬浮框的内容。打开时带着它就按它预填；页面打开后 `id` 变化表示又拖入了新内容，
   * 追加到当前草稿（关联资料去重，标题与内容只在为空时补上）。
   */
  seed?: { id: number; draft: DropDraft } | null;
  /** 全局快捷键传来的临时选区或剪贴板内容。 */
  contextSeed?: { id: number; event: ContextCreateRequestedEvent } | null;
  /** 正有内容拖在页面上：显示「松手添加为关联资料」。 */
  dropActive?: boolean;
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
  inInbox: boolean;
  textSource: "selection" | "clipboard" | null;
  dueDate: string;
  dueTime: string;
  reminder: string;
  priority: PriorityDto;
  projectId: string;
  /** 关联资料：网页与本地文件引用（文件只记位置，不复制）。 */
  links: DraftLink[];
  skippedLinks: number;
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
    inInbox: false,
    textSource: null,
    dueDate: "",
    dueTime: "",
    reminder: "",
    priority: "none",
    projectId: "",
    links: [],
    skippedLinks: 0,
  };
}

/** 一条关联资料的主要文字：网页标题或简短网址，文件名。 */
function linkLabel(link: DraftLink): string {
  return link.kind === "web" ? (link.title ?? shortUrl(link.url)) : link.name;
}

/** 一条关联资料的次要文字：网页的主机名，文件所在的文件夹。 */
function linkDetail(link: DraftLink): string {
  if (link.kind === "file") return link.path.slice(0, link.path.length - link.name.length);
  try {
    return new URL(link.url).hostname.replace(/^www\./, "");
  } catch {
    return link.url;
  }
}

/**
 * 把拖入的内容并进草稿：关联资料追加去重；标题、内容只在为空时补上，不覆盖用户已经写的。
 *
 * @param current 当前草稿。
 * @param dropped 拖入内容提取出的草稿。
 * @param t 翻译函数（多条关联资料的标题「X 等 N 项」）。
 * @returns 合并后的草稿。
 */
function applyDrop(current: Draft, dropped: DropDraft, t: TFunction): Draft {
  const links = mergeLinks(current.links, dropped.links);
  const added = links.slice(current.links.length);
  const incomingCount = new Set([...current.links, ...dropped.links].map(linkKey)).size;
  const first = added[0];
  const suggested =
    dropped.title ??
    (first === undefined
      ? ""
      : added.length === 1
        ? linkLabel(first)
        : t("dropCreate.titleMany", {
            first: linkLabel(first),
            count: added.length,
          }));
  return {
    ...current,
    links,
    skippedLinks: (dropped.skippedLinks ?? 0) + incomingCount - links.length,
    title: current.title.trim() === "" ? suggested.slice(0, MAX_TITLE_CHARS) : current.title,
    content: current.content.trim() === "" ? dropped.content : current.content,
  };
}

/** 关联资料的类型图标：网页、文件、文件夹（没有扩展名的路径按文件夹显示）。 */
function LinkIcon({ link }: { link: DraftLink }) {
  const path =
    link.kind === "web"
      ? "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM1.5 8h13M8 1.5c1.7 1.8 2.5 4 2.5 6.5S9.7 12.7 8 14.5C6.3 12.7 5.5 10.5 5.5 8S6.3 3.3 8 1.5Z"
      : link.name.includes(".")
        ? "M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9.5 1.5ZM9.5 1.5V5H13"
        : "M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4 shrink-0 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
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
  targetDate,
  embedded = false,
  importOnOpen = false,
  onDone,
  onCreated,
  onPasteNonText,
  feedback,
  focusRequest = 0,
  seed = null,
  contextSeed = null,
  dropActive = false,
}: CreateConfigurationProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const hintId = useId();
  const linksId = useId();
  /** 拖入打开时类型取拖入内容的建议；比较基线仍是空白草稿，预填的内容算作修改，取消前会确认。 */
  const [initial] = useState(() => {
    const blank = blankDraft(seed?.draft.kind ?? initialKind, targetDate ?? today);
    const contextText = contextSeed?.event.text;
    if (contextSeed && contextText) {
      const captured = applyDrop(
        {
          ...blank,
          inInbox: true,
          scheduledDate: "",
          textSource: contextSeed.event.source === "selection" ? "selection" : "clipboard",
        },
        textDraft(contextText),
        t,
      );
      return { blank: captured, draft: captured };
    }
    const externalTodo = seed?.draft.kind === "todo" && targetDate === undefined;
    const incoming = externalTodo ? { ...blank, scheduledDate: "", inInbox: true } : blank;
    return { blank, draft: seed === null ? blank : applyDrop(incoming, seed.draft, t) };
  });
  const [draft, setDraft] = useState(initial.draft);
  const baseline = useRef(initial.blank);
  const handledSeed = useRef(seed?.id);
  const handledContextSeed = useRef(contextSeed?.id);
  /** 用户亲自改过计划日期后，默认日期不再覆盖它。 */
  const dateTouched = useRef(targetDate !== undefined);
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
    inInbox,
    textSource,
    dueDate,
    dueTime,
    reminder,
    priority,
    projectId,
    links,
    skippedLinks,
  } = draft;
  /** 修改草稿的部分字段。 */
  const patch = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }));
  const [ready, setReady] = useState(embedded);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<ContextCreateRequestedEvent | null>(null);
  const [importSource, setImportSource] = useState(contextSeed?.event.source ?? null);
  const [showDateSuggestions, setShowDateSuggestions] = useState(true);
  const readingClipboard = useRef(false);
  const requestedInitialImport = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastEditor = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const importOpener = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
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
      current.kind === "note" || current.inInbox || current.scheduledDate !== ""
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
      inInbox,
      textSource,
      dueDate,
      dueTime,
      reminder,
      priority,
      projectId,
      links,
    }: Draft) =>
      ipc.createItem({
        itemType: kind,
        title: title.trim(),
        brief: kind === "note" ? null : brief.trim() || null,
        content: content.trim() === "" ? null : content,
        contentFormat: format,
        priority: kind === "todo" ? priority : "none",
        scheduled:
          kind === "note" || inInbox || scheduledDate === ""
            ? null
            : { date: scheduledDate, time: scheduledTime || null },
        ...(kind === "todo" && inInbox ? { inInbox: true } : {}),
        ...(textSource === null ? {} : { textSource }),
        due: kind !== "todo" || dueDate === "" ? null : { date: dueDate, time: dueTime || null },
        reminderAt: kind === "note" || reminder === "" ? null : reminderToUtc(reminder),
        projectId: projectId || null,
        ...(links.length > 0 ? { links: toLinkDtos(links) } : {}),
      }),
    onSuccess: (item, sent) => {
      onCreated?.(item);
      if (!keepOpenRef.current) {
        onDoneRef.current();
        return;
      }
      // 连续新增：保留类型、日期、格式和项目，清空内容，便于接着录入同一批事项。
      const next: Draft = {
        ...blankDraft(sent.kind, today),
        format: sent.format,
        scheduledDate: sent.kind === "note" ? "" : sent.scheduledDate,
        inInbox: sent.inInbox,
        projectId: sent.projectId,
      };
      baseline.current = next;
      setDraft(next);
      setPendingImport(null);
      setImportError(null);
      setImportSource(null);
      setShowDateSuggestions(true);
      setLastCreated(sent.title.trim());
    },
    onSettled: () => {
      submitting.current = false;
    },
  });

  /** 笔记用文档布局（更大的窗口、整页正文）；待办与提示用表单。 */
  const isDocument = kind === "note";
  const documentRef = useRef(isDocument);
  useEffect(() => {
    if (embedded) return;
    let cancelled = false;
    ipc
      .beginFloatingInput(true, documentRef.current)
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
  }, [embedded]);
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

  // 切换到 / 离开笔记：窗口换成对应布局的尺寸（只调整尺寸，草稿和焦点都保留）。
  useEffect(() => {
    if (embedded || !ready || documentRef.current === isDocument) return;
    documentRef.current = isDocument;
    ipc.beginFloatingInput(true, isDocument).catch(reportError);
  }, [embedded, ready, isDocument]);

  // 页面已打开时又拖入了内容：追加到当前草稿，不另开一页。
  useEffect(() => {
    if (seed === null || seed.id === handledSeed.current) return;
    handledSeed.current = seed.id;
    setDraft((current) => applyDrop(current, seed.draft, t));
    setLastCreated(null);
  }, [seed, t]);

  // 页面已打开时再次请求新增：用户可能已切到别的应用，重新取得原生焦点并回到当前草稿。
  const handledFocusRequest = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === handledFocusRequest.current) return;
    handledFocusRequest.current = focusRequest;
    if (contextSeed !== null && contextSeed.id !== handledContextSeed.current) {
      importOpener.current = lastEditor.current;
    }
    /** 放弃确认打开时聚焦「继续编辑」，否则回到标题。 */
    const focusDraft = () => (confirmDiscard ? keepRef : inputRef).current?.focus();
    if (document.hasFocus()) focusDraft();
    else ipc.beginFloatingInput(true, documentRef.current).then(focusDraft).catch(reportError);
  }, [focusRequest, confirmDiscard, contextSeed]);

  /** 切换类型；计划日期未被改过时按新类型补上默认值。 */
  function changeKind(next: ItemTypeDto): void {
    setDraft((current) => ({
      ...current,
      kind: next,
      scheduledDate:
        !dateTouched.current && !current.inInbox && next !== "note" && current.scheduledDate === ""
          ? (today ?? "")
          : current.scheduledDate,
    }));
  }

  /** 合入导入文本，保留已有标题、正文和用户选定的日期。 */
  function applyImportedText(
    current: Draft,
    text: string,
    append: boolean,
    source: ContextCreateRequestedEvent["source"],
  ): Draft {
    const imported = textDraft(text);
    const next = applyDrop(current, imported, t);
    if (source === "selection" || source === "clipboard") next.textSource = source;
    if (append && (current.title.trim() !== "" || current.content.trim() !== "")) {
      next.content = [current.content, text].filter((part) => part.trim()).join("\n\n");
    }
    if (current.kind === "todo" && !dateTouched.current && !append) {
      return { ...next, inInbox: true, scheduledDate: "", scheduledTime: "" };
    }
    return next;
  }

  const applyContextSeed = useEffectEvent((event: ContextCreateRequestedEvent) => {
    setPendingImport(null);
    setShowDateSuggestions(true);
    if (event.text === null) {
      setImportError(t(`createConfiguration.importSource.${event.source}`));
    } else if (confirmDiscard || differs(draft, baseline.current)) {
      setImportError(null);
      setPendingImport(event);
    } else {
      setImportError(null);
      const next = applyImportedText(
        { ...draft, title: "", content: "" },
        event.text,
        false,
        event.source,
      );
      baseline.current = next;
      setDraft(next);
      setImportSource(event.source);
    }
  });
  useEffect(() => {
    if (contextSeed === null || handledContextSeed.current === contextSeed.id) return;
    handledContextSeed.current = contextSeed.id;
    applyContextSeed(contextSeed.event);
  }, [contextSeed]);

  const clipboardImportMutation = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: () => ipc.readClipboardText(),
    onSuccess: (text) => {
      setShowDateSuggestions(true);
      if (confirmDiscard || differs(draft, baseline.current)) {
        setPendingImport({ text, source: "clipboard" });
      } else {
        setDraft((current) =>
          applyImportedText({ ...current, title: "", content: "" }, text, false, "clipboard"),
        );
        setImportSource("clipboard");
        inputRef.current?.focus();
      }
    },
    onError: (error) => setImportError(errorMessage(toAppError(error))),
    onSettled: () => {
      readingClipboard.current = false;
      setImporting(false);
    },
  });

  /** 一次显式导入只派发一个剪贴板请求。 */
  function importClipboard(): void {
    if (readingClipboard.current) return;
    importOpener.current = lastEditor.current;
    readingClipboard.current = true;
    setImporting(true);
    setImportError(null);
    clipboardImportMutation.mutate();
  }

  /** 取消追加后回到刚才的编辑控件，保留文本选择。 */
  function dismissImport(): void {
    setPendingImport(null);
    const opener = importOpener.current;
    (opener?.isConnected ? opener : inputRef.current)?.focus();
  }

  const initialImport = useEffectEvent(importClipboard);
  useEffect(() => {
    if (!importOnOpen || requestedInitialImport.current) return;
    requestedInitialImport.current = true;
    initialImport();
  }, [importOnOpen]);

  const clipboardImport = (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={importing || pendingImport !== null} size="sm" onClick={importClipboard}>
        {t(
          importing
            ? "createConfiguration.importingClipboard"
            : importError !== null
              ? "common.retry"
              : "createConfiguration.importClipboard",
        )}
      </Button>
      {importError !== null && (
        <p role="alert" className="text-sm text-danger">
          {importError}
        </p>
      )}
      {importSource !== null && (
        <p role="status" className="text-sm text-muted">
          {t(`createConfiguration.importSource.${importSource}`)}
        </p>
      )}
      {pendingImport?.text != null && (
        <>
          <p className="max-h-24 basis-full overflow-y-auto whitespace-pre-wrap break-words text-sm text-muted">
            {pendingImport.text}
          </p>
          <Button
            size="sm"
            onClick={() => {
              const { text, source } = pendingImport;
              if (text === null) return;
              setDraft((current) => applyImportedText(current, text, true, source));
              setImportSource(source);
              setPendingImport(null);
              inputRef.current?.focus();
            }}
          >
            {t("createConfiguration.appendClipboard")}
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissImport}>
            {t("createConfiguration.dismissClipboard")}
          </Button>
        </>
      )}
    </div>
  );

  const dateSuggestions = new Map<string, { date: string; time: string | null }>();
  if (kind === "todo" && today && showDateSuggestions && (content || importSource || seed)) {
    for (const line of [title, ...content.split(/\r?\n/)].slice(0, 30)) {
      const parsed = parseDatePhrase(line, today);
      if (parsed === null) continue;
      const { date, time } = parsed.schedule;
      dateSuggestions.set([date, time].filter(Boolean).join(" "), parsed.schedule);
      if (dateSuggestions.size === 3) break;
    }
  }

  const suggestedDates = dateSuggestions.size > 0 && (
    <Field label={t("createConfiguration.suggestedDates")}>
      {[...dateSuggestions].map(([label, { date, time }]) => (
        <div key={label} className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-text">{label}</span>
          <Button
            size="sm"
            aria-label={t("createConfiguration.applyPlanFor", { date: label })}
            aria-pressed={scheduledDate === date && scheduledTime === (time ?? "") && !inInbox}
            onClick={() => {
              dateTouched.current = true;
              patch({ scheduledDate: date, scheduledTime: time ?? "", inInbox: false });
            }}
          >
            {t("createConfiguration.applyPlan")}
          </Button>
          <Button
            size="sm"
            aria-label={t("createConfiguration.applyDueFor", { date: label })}
            aria-pressed={dueDate === date && dueTime === (time ?? "")}
            onClick={() => patch({ dueDate: date, dueTime: time ?? "" })}
          >
            {t("createConfiguration.applyDue")}
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => setShowDateSuggestions(false)}
      >
        {t("createConfiguration.skipDateSuggestions")}
      </Button>
    </Field>
  );

  const formContent = (
    <Field label={t("detail.field.content")}>
      <Textarea
        aria-label={t("detail.field.content")}
        value={content}
        rows={4}
        placeholder={t("createConfiguration.contentPlaceholder")}
        onChange={(event) => patch({ content: event.target.value })}
      />
    </Field>
  );

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

  /** 类型切换（单选组，方向键切换）；文档布局里用小号按钮放在工具栏上。 */
  const kindSwitch = (
    <div
      role="radiogroup"
      aria-label={t("quickCreate.typeLabel")}
      className={isDocument ? "flex gap-1" : "flex flex-wrap gap-2"}
      onKeyDown={(event) => {
        if (isImeKey(event.nativeEvent)) return;
        if (!["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"].includes(event.key))
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
          size={isDocument ? "sm" : "md"}
          variant={kind === option ? "primary" : isDocument ? "ghost" : "secondary"}
          onClick={() => changeKind(option)}
        >
          {t(`quickCreate.kind.${option}`)}
        </Button>
      ))}
    </div>
  );

  /** 标题变化：同时清掉「已创建」提示。 */
  const onTitleChange = (value: string) => {
    patch({ title: value });
    setLastCreated(null);
  };

  /** 标题里粘贴的不是文字（文件 / 图片）：收进收集箱，保留草稿。 */
  const onTitlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (onPasteNonText && !event.clipboardData.getData("text/plain")) {
      event.preventDefault();
      onPasteNonText();
    }
  };

  /** 关联资料列表（拖入的网页、本地文件引用）。 */
  const linksSection = links.length > 0 && (
    <section className="flex flex-col gap-2" aria-labelledby={linksId}>
      <h2 id={linksId} className="text-sm font-medium text-text">
        {t("dropCreate.links", { count: links.length })}
      </h2>
      {skippedLinks > 0 && (
        <p role="status" className="text-sm text-muted">
          {t("dropCreate.linksSkipped", { count: skippedLinks })}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {links.map((link) => (
          <li
            key={linkKey(link)}
            className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
          >
            <LinkIcon link={link} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-text" title={linkLabel(link)}>
                {linkLabel(link)}
              </p>
              <p
                className="truncate text-xs text-muted"
                title={link.kind === "web" ? link.url : link.path}
              >
                {linkDetail(link)}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("dropCreate.remove", { name: linkLabel(link) })}
              onClick={() =>
                patch({ links: links.filter((other) => linkKey(other) !== linkKey(link)) })
              }
            >
              {t("dropCreate.removeShort")}
            </Button>
          </li>
        ))}
      </ul>
      {links.some((link) => link.kind === "file") && (
        <p className="text-xs text-muted">{t("dropCreate.referenceNote")}</p>
      )}
    </section>
  );

  const projectField = (
    <Field label={t("detail.field.project")}>
      <ProjectSelect value={projectId} onChange={(value) => patch({ projectId: value })} />
    </Field>
  );

  const characters = [...content].length;
  const lines = content === "" ? 0 : content.split("\n").length;
  const scheduledToday = !inInbox && scheduledDate !== "" && scheduledDate === today;
  const selectedDate = !inInbox && scheduledDate !== "" && scheduledDate !== today;

  return (
    <form
      ref={formRef}
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : true}
      aria-labelledby={headingId}
      aria-describedby={hintId}
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl bg-surface text-text"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onFocusCapture={(event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          lastEditor.current = target;
        }
      }}
      onKeyDown={(event) => {
        // 正文的 Markdown 按键已经处理（列表缩进的 Tab、勾选任务的 Ctrl+Enter）：不再当作切换焦点或创建。
        if (isImeKey(event.nativeEvent) || event.defaultPrevented) return;
        trapTab(event, event.currentTarget);
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (confirmDiscard) {
            setConfirmDiscard(false);
            inputRef.current?.focus();
          } else if (pendingImport !== null) {
            dismissImport();
          } else cancel();
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          submit();
        } else if (event.key === "Enter" && event.target instanceof HTMLInputElement)
          event.preventDefault();
      }}
    >
      {isDocument ? (
        <>
          <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3">
            <div className="mr-auto min-w-0">
              <h1 id={headingId} className="text-base font-semibold">
                {t("createConfiguration.noteTitle")}
              </h1>
              <p id={hintId} className="text-xs text-muted">
                {t("createConfiguration.noteHint")}
              </p>
            </div>
            <fieldset
              disabled={!ready || create.isPending || confirmDiscard}
              className="flex flex-wrap items-center gap-3 border-0 p-0"
            >
              {kindSwitch}
              {clipboardImport}
              <div
                role="group"
                aria-label={t("detail.field.format")}
                className="flex gap-0.5 rounded-md border border-border p-0.5"
              >
                {(["plain", "markdown"] as const).map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={format === option ? "secondary" : "ghost"}
                    aria-pressed={format === option}
                    onClick={() => patch({ format: option })}
                  >
                    {t(`detail.format.${option}`)}
                  </Button>
                ))}
              </div>
            </fieldset>
          </header>
          <fieldset
            disabled={!ready || create.isPending || confirmDiscard}
            className="flex min-h-0 flex-1 flex-col border-0 p-0 min-[760px]:flex-row"
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-2 px-8 pt-6">
                <input
                  ref={inputRef}
                  aria-label={t("detail.field.title")}
                  value={title}
                  required
                  placeholder={t("createConfiguration.noteTitlePlaceholder")}
                  maxLength={MAX_TITLE_CHARS}
                  onChange={(event) => onTitleChange(event.target.value)}
                  onPaste={onTitlePaste}
                  onKeyDown={(event) => {
                    // 标题里按 Enter 直接开始写正文。
                    if (event.key !== "Enter" || isImeKey(event.nativeEvent)) return;
                    if (event.ctrlKey || event.metaKey) return;
                    event.preventDefault();
                    bodyRef.current?.focus();
                  }}
                  className="w-full bg-transparent text-2xl font-semibold text-text placeholder:text-muted focus-visible:outline-none"
                />
                <textarea
                  ref={bodyRef}
                  aria-label={t("detail.field.content")}
                  value={content}
                  placeholder={t("createConfiguration.noteBodyPlaceholder")}
                  onChange={(event) => patch({ content: event.target.value })}
                  onKeyDown={(event) => {
                    if (format === "markdown")
                      handleMarkdownKeyDown(event, (next) => patch({ content: next }));
                  }}
                  onPaste={(event) => {
                    if (format === "markdown")
                      handleMarkdownPaste(event, (next) => patch({ content: next }));
                  }}
                  className="min-h-48 w-full flex-1 resize-none bg-transparent py-1 text-[15px] leading-relaxed text-text placeholder:text-muted focus-visible:outline-none disabled:opacity-50"
                />
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-8 py-2 text-xs text-muted">
                <span>
                  {format === "markdown"
                    ? t("createConfiguration.markdownHint")
                    : t("createConfiguration.plainHint")}
                </span>
                <span className="tabular-nums" aria-live="off">
                  {t("createConfiguration.noteStats", { characters, lines })}
                </span>
              </div>
            </div>
            <aside
              aria-label={t("createConfiguration.noteDetails")}
              className="grid max-h-40 shrink-0 grid-cols-1 content-start gap-4 overflow-y-auto border-t border-border bg-bg px-5 py-4 min-[560px]:grid-cols-2 min-[760px]:flex min-[760px]:max-h-none min-[760px]:w-72 min-[760px]:flex-col min-[760px]:gap-5 min-[760px]:border-t-0 min-[760px]:border-l min-[760px]:p-5"
            >
              {projectField}
              {linksSection ||
                (!embedded && (
                  <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium text-text">
                      {t("createConfiguration.linksHeading")}
                    </h2>
                    <p className="text-xs text-muted">{t("createConfiguration.linksEmpty")}</p>
                  </div>
                ))}
            </aside>
          </fieldset>
        </>
      ) : (
        <>
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
              {kindSwitch}
              {clipboardImport}
              <Field label={t("createConfiguration.titleLabel")}>
                <Input
                  ref={inputRef}
                  aria-label={t("detail.field.title")}
                  value={title}
                  required
                  placeholder={t("createConfiguration.titlePlaceholder")}
                  maxLength={MAX_TITLE_CHARS}
                  onChange={(event) => onTitleChange(event.target.value)}
                  onPaste={onTitlePaste}
                />
              </Field>
              {kind === "todo" && (
                <Field label={t("createConfiguration.destination")}>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      aria-pressed={inInbox}
                      variant={inInbox ? "primary" : "secondary"}
                      onClick={() => {
                        dateTouched.current = true;
                        patch({ inInbox: true, scheduledDate: "", scheduledTime: "" });
                      }}
                    >
                      {t("createConfiguration.toInbox")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={today === undefined}
                      aria-pressed={scheduledToday}
                      variant={scheduledToday ? "primary" : "secondary"}
                      onClick={() => {
                        dateTouched.current = true;
                        patch({ inInbox: false, scheduledDate: today ?? "", scheduledTime: "" });
                      }}
                    >
                      {t("createConfiguration.toToday")}
                    </Button>
                    <Button
                      size="sm"
                      aria-pressed={selectedDate}
                      variant={selectedDate ? "primary" : "secondary"}
                      onClick={() =>
                        formRef.current
                          ?.querySelector<HTMLInputElement>("[data-scheduled-date]")
                          ?.focus()
                      }
                    >
                      {selectedDate
                        ? t("createConfiguration.selectedDate", { date: scheduledDate })
                        : t("createConfiguration.chooseDate")}
                    </Button>
                  </div>
                </Field>
              )}
              {textSource !== null ? (
                <details open>
                  <summary className="mb-2 cursor-pointer text-sm font-medium text-text">
                    {lines > 0
                      ? t("createConfiguration.originalMessage", { count: lines })
                      : t("detail.field.content")}
                  </summary>
                  {formContent}
                </details>
              ) : (
                formContent
              )}
              {suggestedDates}
              <Field label={t("detail.field.brief")}>
                <Input
                  aria-label={t("detail.field.brief")}
                  value={brief}
                  placeholder={t("detail.briefPlaceholder")}
                  onChange={(event) => patch({ brief: event.target.value })}
                />
              </Field>
              {linksSection}
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
              <section
                className="border-t border-border pt-5"
                aria-label={t("createConfiguration.schedule")}
              >
                <h2 className="mb-4 text-base font-semibold">
                  {t("createConfiguration.schedule")}
                </h2>
                <div className="grid grid-cols-1 gap-4 min-[460px]:grid-cols-2">
                  <Field label={t("detail.field.scheduled")}>
                    <Input
                      type="date"
                      aria-label={t("detail.field.scheduledDate")}
                      data-scheduled-date
                      value={scheduledDate}
                      onChange={(event) => {
                        dateTouched.current = true;
                        patch(
                          event.target.value
                            ? { scheduledDate: event.target.value, inInbox: false }
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
              <section
                className="border-t border-border pt-5"
                aria-label={t("createConfiguration.organize")}
              >
                <h2 className="mb-4 text-base font-semibold">
                  {t("createConfiguration.organize")}
                </h2>
                <div className="grid grid-cols-1 gap-4 min-[460px]:grid-cols-2">
                  {projectField}
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
        </>
      )}
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
      {dropActive && (
        <div className="nv-drop-zone pointer-events-none absolute inset-2 flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-primary bg-surface/90">
          <p className="text-base font-semibold text-primary">{t("dropCreate.appendTitle")}</p>
          <p className="text-sm text-muted">{t("dropCreate.appendHint")}</p>
        </div>
      )}
    </form>
  );
}
