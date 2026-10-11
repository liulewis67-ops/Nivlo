import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components";
import { ipc } from "@/lib/ipc";
import type { ItemTypeDto } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import { parseDatePhrase } from "./model/date-phrase";
import type { DatePhraseResult } from "./model/date-phrase";
import { cycleKind, normalizeTitle, resolveKey } from "./model/quick-create";
import { format } from "date-fns";

/** 输入获得焦点后等待多久确认窗口真的拿到了系统焦点（毫秒）。 */
const FOCUS_CHECK_DELAY_MS = 500;

/** [`QuickCreateForm`] 的 Props。 */
export type QuickCreateFormProps = {
  /** 要创建的类型。 */
  kind: ItemTypeDto;
  /** 按 Tab / Shift+Tab 切换类型时调用；不提供时不响应 Tab（保持默认的焦点移动）。 */
  onKindChange?: ((kind: ItemTypeDto) => void) | undefined;
  /**
   * 在输入框里粘贴了**不是文字**的内容（文件 / 图片）时调用；不提供时按浏览器默认处理。
   * 普通文本的粘贴仍然是输入行为（实施计划 2.5）。
   */
  onPasteNonText?: (() => void) | undefined;
  /**
   * 今天（`YYYY-MM-DD`，用户本地日期，取自后端的 Today 视图），用来解析标题里的日期短语；
   * 没有时用本机日期。
   */
  today?: string | undefined;
  /** 结束时调用：无论是创建成功、取消、失去焦点还是无法获得焦点。 */
  onDone: () => void;
};

/**
 * 悬浮窗里的快速创建输入行（产品文档 §6.1「先创建，再整理」）。
 *
 * 生命周期与键盘焦点（这是悬浮窗唯一会主动抢焦点的时刻）：
 *
 * 1. 挂载时请求后端 `beginFloatingInput`：记住用户当前的应用、让悬浮窗临时可聚焦并聚焦，
 *    完成后才聚焦输入框；失败（窗口无法聚焦）时提示错误并结束；
 * 2. Enter 创建（输入法组合期间与空标题不提交），Esc 取消，Tab / Shift+Tab 在待办 / 笔记 / 提示之间切换；
 *    粘贴文字是普通输入，粘贴文件 / 图片则收进 Inbox；
 * 3. 窗口失去系统焦点（用户点了别处）视为取消；
 * 4. 卸载时（创建成功 / 取消 / 失败都会卸载）请求 `endFloatingInput`，
 *    后端恢复"不可聚焦"并把焦点还给用户之前的应用。
 *
 * 默认值（日期等）由后端决定，前端只提交类型与标题。
 *
 * @param props 类型与结束回调。
 * @returns 输入行。
 */
export function QuickCreateForm({
  kind,
  onKindChange,
  onPasteNonText,
  today,
  onDone,
}: QuickCreateFormProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [isReady, setIsReady] = useState(false);
  /** 用户取消了对哪一段日期短语的识别（短语文字本身变了就重新识别）。 */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 保持 `onDone` 的最新引用，避免把它放进 effect 依赖导致重复申请焦点。 */
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const parsed = parseTitle(title, today, dismissed);
  const create = useMutation({
    mutationFn: (value: { title: string; scheduled: DatePhraseResult["schedule"] | null }) =>
      ipc.quickCreate(kind, value.title, value.scheduled),
    onSuccess: () => onDoneRef.current(),
  });

  // 申请键盘焦点；卸载时无论如何都要归还。
  useEffect(() => {
    let cancelled = false;
    ipc
      .beginFloatingInput()
      .then(() => {
        if (!cancelled) setIsReady(true);
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

  // 输入框在窗口拿到焦点之前是禁用的；启用之后再聚焦它。
  useEffect(() => {
    if (isReady) inputRef.current?.focus();
  }, [isReady]);

  // 获得焦点之后：窗口失去系统焦点就取消；并确认窗口确实拿到了焦点，
  // 否则键盘输入无处可去，用户会被困在一个不响应的输入行里。
  useEffect(() => {
    if (!isReady) return;
    /** 窗口失去系统焦点（用户点了别处）：视为取消。 */
    const handleBlur = () => onDoneRef.current();
    window.addEventListener("blur", handleBlur);
    const check = setTimeout(() => {
      if (!document.hasFocus()) onDoneRef.current();
    }, FOCUS_CHECK_DELAY_MS);
    return () => {
      window.removeEventListener("blur", handleBlur);
      clearTimeout(check);
    };
  }, [isReady]);

  /**
   * 处理按键：Enter 创建，Esc 取消。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // 光标在末尾、刚识别出的日期短语也在末尾时，第一下退格只是取消识别（标题文字保持不变）。
    const input = event.currentTarget;
    if (
      event.key === "Backspace" &&
      parsed !== null &&
      parsed.endsAtTail &&
      input.selectionStart === title.length &&
      input.selectionEnd === title.length
    ) {
      event.preventDefault();
      setDismissed(phraseText(title, parsed));
      return;
    }
    const action = resolveKey({
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      title,
      shiftKey: event.shiftKey,
    });
    if (action === "nextKind" || action === "previousKind") {
      if (onKindChange === undefined) return;
      event.preventDefault();
      onKindChange(cycleKind(kind, action === "previousKind"));
    } else if (action === "submit" && !create.isPending) {
      event.preventDefault();
      create.mutate(
        parsed === null
          ? { title: normalizeTitle(title), scheduled: null }
          : { title: parsed.title, scheduled: parsed.schedule },
      );
    } else if (action === "cancel") {
      event.preventDefault();
      onDone();
    }
  }

  /**
   * 粘贴：纯文字照常进入输入框；没有文字（剪贴板里是文件或图片）时改为收进 Inbox。
   *
   * @param event 粘贴事件。
   */
  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    if (onPasteNonText === undefined) return;
    if (event.clipboardData.getData("text/plain").length > 0) return;
    event.preventDefault();
    onPasteNonText();
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded-sm bg-surface-hover px-1.5 py-0.5 text-xs text-muted">
          {t(`quickCreate.kind.${kind}`)}
        </span>
        <Input
          ref={inputRef}
          aria-label={t("quickCreate.input.label")}
          placeholder={t("quickCreate.input.placeholder")}
          value={title}
          disabled={!isReady || create.isPending}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          className="h-8"
        />
      </div>
      {parsed !== null && (
        <div
          role="status"
          className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs text-text"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-3.5 shrink-0 text-primary"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
            <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
          </svg>
          <span className="min-w-0 flex-1 truncate">
            {t("quickCreate.parsed.label", { label: parsed.label })}
          </span>
          <span className="shrink-0 text-muted">{t("quickCreate.parsed.hint")}</span>
          <button
            type="button"
            aria-label={t("quickCreate.parsed.cancel")}
            // mousedown 而不是 click：避免输入框失焦被当成「取消快速创建」。
            onMouseDown={(event) => {
              event.preventDefault();
              setDismissed(phraseText(title, parsed));
              inputRef.current?.focus();
            }}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted hover:bg-primary/20 hover:text-text"
          >
            {"✕"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 被识别出来的短语原文（日期与时间用「|」连接）：用来判断用户取消的是不是同一段短语。
 *
 * @param text 输入框文本。
 * @param result 识别结果。
 * @returns 短语原文。
 */
function phraseText(text: string, result: DatePhraseResult): string {
  return result.spans.map(([start, end]) => text.slice(start, end)).join("|");
}

/**
 * 解析标题里的日期短语；用户已经取消了的那一段不再识别。
 *
 * @param title 输入框文本。
 * @param today 今天；缺省用本机日期。
 * @param dismissed 用户取消识别的短语原文。
 * @returns 识别结果，或 `null`。
 */
function parseTitle(
  title: string,
  today: string | undefined,
  dismissed: string | null,
): DatePhraseResult | null {
  const result = parseDatePhrase(title, today ?? format(new Date(), "yyyy-MM-dd"));
  return result === null || phraseText(title, result) === dismissed ? null : result;
}
