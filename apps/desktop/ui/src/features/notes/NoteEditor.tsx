import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Textarea } from "@/components";
import { useItemDraft } from "@/features/detail";
import { useOrganize } from "@/features/inbox";
import { useDeleteItems } from "@/features/trash";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import { handleMarkdownKeyDown, handleMarkdownPaste } from "@/lib/markdown-keys";
import { useDraftTransitionStore } from "@/stores/draft-transition-store";
import { DraftRecovery } from "@/features/detail";

/** [`NoteEditor`] 的 Props。 */
export type NoteEditorProps = {
  /** 笔记 ID；父级必须先通过导航的草稿检查，再用新 `key` 挂载另一篇。 */
  id: string;
  /** 刚新建的笔记：标题出现时聚焦并全选，直接打字就替换掉「未命名笔记」。 */
  focusTitle?: boolean;
  /** 归档或删除这篇之前调用（笔记页借此把焦点放到列表里接下来的那一篇）。 */
  onLeave?: () => void;
};

/**
 * 标题框挂载时聚焦并全选（作为 ref 回调；函数固定不变，所以只在挂载时调用一次）。
 *
 * @param input 标题框；卸载时为 `null`。
 */
function focusAndSelect(input: HTMLInputElement | null): void {
  input?.focus();
  input?.select();
}

/**
 * 在标题里按 Enter 跳到正文（输入法组字时的 Enter 不算）。
 *
 * @param event 键盘事件。
 */
function enterMovesToBody(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
  const body = event.currentTarget.parentElement?.querySelector("textarea");
  if (body === null || body === undefined) return;
  event.preventDefault();
  body.focus();
}

/**
 * 笔记编辑区：大标题输入、整页的正文输入、格式切换，自动保存（和详情面板共用同一套逻辑）。
 *
 * 长文（上万字）也只是一个原生文本框，没有逐字符的渲染工作，所以输入不会卡；
 * 保存只发送变化的字段，并且停止输入 700ms 后才发。
 * 保存失败时内容仍在文本框里，顶部显示原因与「重试」。
 *
 * @param props 笔记 ID；刚新建时聚焦标题。
 * @returns 编辑区。
 */
export function NoteEditor({ id, focusTitle = false, onLeave }: NoteEditorProps) {
  const { t } = useTranslation();
  const { query, draft, status, problem, owner, edit, save } = useItemDraft(id);
  const { organize } = useOrganize();
  const { remove } = useDeleteItems();

  if (query.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted">
        {errorMessage(toAppError(query.error))}
      </div>
    );
  }
  if (draft === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {t("detail.loading")}
      </div>
    );
  }
  const characters = [...draft.content].length;

  return (
    <article aria-label={t("notes.editor")} className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-8 py-3">
        <div className="flex items-center gap-3 text-xs text-muted">
          <span role="status">
            {status === "saving" && t("detail.status.saving")}
            {status === "saved" && t("detail.status.saved")}
            {status === "error" && t("detail.status.error")}
          </span>
          <span className="tabular-nums">{t("notes.characters", { count: characters })}</span>
        </div>
        <div className="flex items-center gap-1">
          <div role="group" aria-label={t("detail.field.format")} className="flex gap-0.5">
            {(["plain", "markdown"] as const).map((format) => (
              <Button
                key={format}
                size="sm"
                variant={draft.contentFormat === format ? "secondary" : "ghost"}
                aria-pressed={draft.contentFormat === format}
                onClick={() => edit({ contentFormat: format })}
              >
                {t(`detail.format.${format}`)}
              </Button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              useDraftTransitionStore.getState().request(() => {
                onLeave?.();
                void organize([id], "archive", draft.title);
              });
            }}
          >
            {t("inbox.action.archive")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            onClick={() => {
              useDraftTransitionStore.getState().request(() => {
                onLeave?.();
                void remove([id], draft.title);
              });
            }}
          >
            {t("trash.delete")}
          </Button>
        </div>
      </header>
      {problem !== null && (
        <div className="mx-8 mt-3">
          <DraftRecovery owner={owner} problem={problem} save={save} />
        </div>
      )}
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 px-8 py-6">
        <input
          ref={focusTitle ? focusAndSelect : undefined}
          aria-label={t("detail.field.title")}
          value={draft.title}
          placeholder={t("notes.untitled")}
          onChange={(event) => edit({ title: event.target.value })}
          onKeyDown={enterMovesToBody}
          className="w-full bg-transparent text-2xl font-semibold text-text placeholder:text-muted focus-visible:outline-none"
        />
        <Textarea
          aria-label={t("detail.field.content")}
          placeholder={t("detail.contentPlaceholder")}
          value={draft.content}
          onChange={(event) => edit({ content: event.target.value })}
          onKeyDown={(event) => {
            if (draft.contentFormat === "markdown") {
              handleMarkdownKeyDown(event, (content) => edit({ content }));
            }
          }}
          onPaste={(event) => {
            if (draft.contentFormat === "markdown") {
              handleMarkdownPaste(event, (content) => edit({ content }));
            }
          }}
          className="min-h-0 w-full flex-1 resize-none border-transparent bg-transparent px-0 text-[15px] leading-relaxed focus-visible:border-transparent"
        />
      </div>
    </article>
  );
}
