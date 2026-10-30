import { useMutation } from "@tanstack/react-query";
import { parseISO } from "date-fns";
import { formatDate } from "@/lib/date-format";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components";
import { DatePhraseChip, normalizeTitle, resolveKey, useDatePhrase } from "@/features/quick-create";
import type { DatePhraseResult } from "@/features/quick-create";
import { useDeleteItems } from "@/features/trash";
import { useToastStore } from "@/stores/toast-store";
import { ipc } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import { useTodayQuery } from "./api";
import { TodayBoard } from "./TodayBoard";

/**
 * 主窗口的 Today 视图（实施计划 1.10）：和悬浮面板共用同一份查询缓存与同一套交互，
 * 在宽敞的空间里多给出日期、进度和一个始终可用的快速添加输入框。
 *
 * 在这里完成 / 排序 / 推迟，悬浮窗徽标与列表会通过后端事件同步更新，反之亦然。
 *
 * @returns Today 页面。
 */
export function TodayPage() {
  const { t } = useTranslation();
  const view = useTodayQuery().data;
  const [title, setTitle] = useState("");
  // 和快速创建同样识别日期短语（「明天下午3点 评审方案」），在输入框下方提示，退格或 ✕ 取消。
  const datePhrase = useDatePhrase(title, view?.date);
  const { parsed } = datePhrase;

  const create = useMutation({
    mutationFn: (value: { raw: string; parsed: DatePhraseResult | null }) =>
      value.parsed === null
        ? ipc.quickCreate("todo", value.raw)
        : ipc.quickCreate("todo", value.parsed.title, value.parsed.schedule),
    onSuccess: (_, value) => {
      // 排到了别的日子：它不会出现在今天的列表里，告诉用户去了哪里，免得以为没加上。
      if (value.parsed !== null && value.parsed.schedule.date !== view?.date) {
        useToastStore
          .getState()
          .push("success", t("today.page.addedElsewhere", { label: value.parsed.label }));
      }
    },
    // 失败时把用户写的内容放回输入框，不让他重新输入。
    onError: (error, value) => {
      setTitle((current) => (current === "" ? value.raw : current));
      reportError(error);
    },
  });

  const { remove } = useDeleteItems();
  const sectionRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl+N（macOS ⌘N）跳到添加框（与笔记页的「新建」一致）；有对话框打开时不响应。
  useEffect(() => {
    /**
     * 「新建」快捷键。
     *
     * @param event 键盘事件。
     */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "n") return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      event.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  /**
   * 处理按键：Enter 创建待办（输入法组合期间与空标题不提交），Esc 清空；↓ 移到第一条待办的完成框。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (datePhrase.handleBackspace(event)) return;
    if (event.key === "ArrowDown" && !event.nativeEvent.isComposing) {
      const first = sectionRef.current?.querySelector<HTMLElement>("[role=checkbox]");
      if (first !== null && first !== undefined) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    const action = resolveKey({
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      title,
    });
    if (action === "cancel" && title !== "") {
      // Esc 清空写了一半的内容（连同识别出的日期）；空的时候不拦，交给页面。
      event.preventDefault();
      event.stopPropagation();
      setTitle("");
      datePhrase.reset();
      return;
    }
    if (action === "submit") {
      event.preventDefault();
      // 立即清空输入框，用户可以紧接着输入下一条（连续记录多件事），不必等后端返回。
      const value = { raw: normalizeTitle(title), parsed };
      setTitle("");
      datePhrase.reset();
      create.mutate(value);
    }
  }

  const remaining = view?.remainingCount ?? 0;
  const done = view?.completed.length ?? 0;
  const total = remaining + done;
  const hasContent =
    view !== undefined &&
    (view.todos.length > 0 || view.tips.length > 0 || view.completed.length > 0);

  return (
    <section
      ref={sectionRef}
      aria-label={t("today.page.label")}
      className="relative flex h-full flex-col"
      // 在第一条的完成框上再按 ↑ 回到添加框（列表里的 ↑ ↓ 到头就不处理，冒泡到这里）。
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" || !(event.target instanceof HTMLElement)) return;
        const first = sectionRef.current?.querySelector("[role=checkbox]");
        if (event.target !== first) return;
        event.preventDefault();
        inputRef.current?.focus();
      }}
    >
      <header className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-8 pt-7 pb-4">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold text-text">{t("today.panel.title")}</h1>
          <span className="text-sm text-muted">
            {formatDate(view === undefined ? new Date() : parseISO(view.date), "monthDayWeekday")}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label={t("today.page.progress")}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-(--nv-duration-normal) ease-(--nv-ease-standard)"
              style={{ width: total === 0 ? "0%" : `${Math.round((done / total) * 100)}%` }}
            />
          </div>
          <span className="text-xs text-muted tabular-nums">
            {total === 0
              ? t("today.page.nothingPlanned")
              : remaining === 0
                ? t("today.page.allDone")
                : t("today.page.remaining", { count: remaining })}
          </span>
        </div>
        <Input
          ref={inputRef}
          aria-keyshortcuts="Control+N"
          aria-label={t("today.page.addLabel")}
          placeholder={t("today.page.addPlaceholder")}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {parsed !== null && <DatePhraseChip parsed={parsed} onDismiss={datePhrase.dismiss} />}
      </header>
      {hasContent ? (
        <div className="min-h-0 flex-1 overflow-y-auto pb-6">
          <div className="mx-auto w-full max-w-3xl px-5">
            <TodayBoard view={view} onDelete={(item) => void remove([item.id], item.title)} />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 pb-16 text-center">
          <p className="text-base font-medium text-text">{t("today.empty.title")}</p>
          <p className="text-sm text-muted">{t("today.page.emptyHint")}</p>
        </div>
      )}
    </section>
  );
}
