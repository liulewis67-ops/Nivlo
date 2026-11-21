import { isImeKey } from "@/lib/ime";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@/components";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import type { ItemTypeDto } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import { DatePhraseChip, useDatePhrase } from "./DatePhraseChip";
import type { DatePhraseResult } from "./model/date-phrase";
import { QUICK_CREATE_KINDS, cycleKind, normalizeTitle, resolveKey } from "./model/quick-create";

/** 输入获得焦点后等待多久确认窗口真的拿到了系统焦点（毫秒）。 */
const FOCUS_CHECK_DELAY_MS = 500;

/** [`QuickCreateForm`] 的 Props。 */
export type QuickCreateFormProps = {
  /** 要创建的类型。 */
  kind: ItemTypeDto;
  /** 在可见类型组内选择类型；Tab 始终按标准顺序移动焦点。 */
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
 * 2. Enter 创建（输入法组合期间与空标题不提交），Esc 取消；类型组用方向键选择，Tab 正常移入/离开；
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
  const inputRef = useRef<HTMLInputElement>(null);
  /** 保持 `onDone` 的最新引用，避免把它放进 effect 依赖导致重复申请焦点。 */
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const datePhrase = useDatePhrase(title, today);
  const { parsed } = datePhrase;
  const create = useMutation({
    meta: { errorPresentation: "inline" },
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
    if (datePhrase.handleBackspace(event)) return;
    const action = resolveKey({
      key: event.key,
      isComposing: isImeKey(event.nativeEvent),
      title,
      shiftKey: event.shiftKey,
    });
    if (action === "submit" && !create.isPending) {
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
    <div
      className="flex flex-col gap-2 border-t border-border px-3 py-2"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !isImeKey(event.nativeEvent) &&
          event.target !== inputRef.current
        ) {
          event.preventDefault();
          event.stopPropagation();
          onDone();
        }
      }}
    >
      {onKindChange && (
        <div
          role="radiogroup"
          aria-label={t("quickCreate.typeLabel")}
          className="flex flex-wrap gap-1"
          onKeyDown={(event) => {
            if (isImeKey(event.nativeEvent)) return;
            const backwards = event.key === "ArrowLeft" || event.key === "ArrowUp";
            if (
              !backwards &&
              event.key !== "ArrowRight" &&
              event.key !== "ArrowDown" &&
              event.key !== "Home" &&
              event.key !== "End"
            )
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? "todo"
                : event.key === "End"
                  ? "tip"
                  : cycleKind(kind, backwards);
            onKindChange(next);
            event.currentTarget.querySelector<HTMLElement>(`[data-kind="${next}"]`)?.focus();
          }}
        >
          {QUICK_CREATE_KINDS.map((option) => (
            <Button
              key={option}
              role="radio"
              aria-checked={kind === option}
              data-kind={option}
              tabIndex={kind === option ? 0 : -1}
              size="sm"
              variant={kind === option ? "primary" : "ghost"}
              disabled={!isReady || create.isPending}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onKindChange(option)}
            >
              {t(`quickCreate.kind.${option}`)}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        {!onKindChange && (
          <span className="shrink-0 rounded-sm bg-surface-hover px-1.5 py-0.5 text-xs text-muted">
            {t(`quickCreate.kind.${kind}`)}
          </span>
        )}
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
      {create.isError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
          <p>{errorMessage(toAppError(create.error))}</p>
          <Button
            size="sm"
            onClick={() => {
              inputRef.current?.focus();
              create.reset();
            }}
          >
            {t("quickCreate.retry")}
          </Button>
        </div>
      )}
      {parsed !== null && (
        <DatePhraseChip
          parsed={parsed}
          onDismiss={() => {
            datePhrase.dismiss();
            inputRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
