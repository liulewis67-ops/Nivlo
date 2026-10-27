import { format } from "date-fns";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { parseDatePhrase } from "./model/date-phrase";
import type { DatePhraseResult } from "./model/date-phrase";

/** [`useDatePhrase`] 的返回值。 */
export type DatePhrase = {
  /** 识别到的日期短语；没有、或用户取消了这一段时为 `null`。 */
  parsed: DatePhraseResult | null;
  /** 取消对当前这一段短语的识别（标题文字保持不变）。 */
  dismiss: () => void;
  /**
   * 光标在末尾、刚识别出的短语也在末尾时，第一下退格只是取消识别。
   *
   * @returns 处理了这次按键（调用方不要再处理）时为 `true`。
   */
  handleBackspace: (event: KeyboardEvent<HTMLInputElement>) => boolean;
  /** 提交之后清掉「已取消」的记录，下一条重新识别。 */
  reset: () => void;
};

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
 * 识别标题里的日期 / 时间短语（「明天下午3点 评审方案」），并记住用户取消了哪一段。
 *
 * 悬浮窗的快速创建与主窗口 Today 的输入框共用，规则一致：识别结果在输入框下方提示，退格或 ✕ 取消。
 *
 * @param title 输入框文本。
 * @param today 今天（`YYYY-MM-DD`，用户本地日期）；缺省用本机日期。
 * @returns 识别结果与取消操作。
 */
export function useDatePhrase(title: string, today?: string): DatePhrase {
  /** 用户取消了对哪一段日期短语的识别（短语文字本身变了就重新识别）。 */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const result = parseDatePhrase(title, today ?? format(new Date(), "yyyy-MM-dd"));
  const parsed = result === null || phraseText(title, result) === dismissed ? null : result;
  return {
    parsed,
    dismiss: () => {
      if (parsed !== null) setDismissed(phraseText(title, parsed));
    },
    handleBackspace: (event) => {
      const input = event.currentTarget;
      if (
        event.key !== "Backspace" ||
        parsed === null ||
        !parsed.endsAtTail ||
        input.selectionStart !== title.length ||
        input.selectionEnd !== title.length
      ) {
        return false;
      }
      event.preventDefault();
      setDismissed(phraseText(title, parsed));
      return true;
    },
    reset: () => setDismissed(null),
  };
}

/** [`DatePhraseChip`] 的 Props。 */
export type DatePhraseChipProps = {
  /** 识别结果。 */
  parsed: DatePhraseResult;
  /** 点 ✕ 取消识别。 */
  onDismiss: () => void;
};

/**
 * 输入框下方的「识别到计划：明天 · 10月28日 周三」提示，带取消按钮。
 *
 * @param props 识别结果与取消回调。
 * @returns 提示条。
 */
export function DatePhraseChip({ parsed, onDismiss }: DatePhraseChipProps) {
  const { t } = useTranslation();
  return (
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
        // mousedown 而不是 click：避免输入框失焦（悬浮窗里失焦会被当成取消快速创建）。
        onMouseDown={(event) => {
          event.preventDefault();
          onDismiss();
        }}
        className="flex size-4 shrink-0 items-center justify-center rounded text-muted hover:bg-primary/20 hover:text-text"
      >
        {"✕"}
      </button>
    </div>
  );
}
