import { useMutation, useQuery } from "@tanstack/react-query";
import { parseISO } from "date-fns";
import { distanceToNow } from "@/lib/date-format";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { moveFocusWithArrows } from "@/lib/arrow-focus";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { noteSnippet } from "./model/note-snippet";
import { NoteEditor } from "./NoteEditor";

/**
 * 主窗口的 Notes 视图（实施计划 3.2、产品文档 §17「快速记录、基本编辑」）：
 * 左边是最近更新的笔记，右边是编辑区。
 *
 * * 「+ 新笔记」立刻创建一篇并打开，先写下来再说（先创建，再整理）；
 * * 编辑区自动保存（同详情面板，保存失败不丢内容）；
 * * 归档带可撤销的提示；
 * * 没有选中时默认打开最近更新的那一篇，一篇都没有时引导用户新建。
 *
 * @returns Notes 页面。
 */
export function NotesPage() {
  const { t } = useTranslation();
  const notes = useQuery({
    queryKey: queryKeys.notes(),
    queryFn: () =>
      ipc.listItems({ itemType: "note", includeArchived: false, orderBy: "updated", limit: null }),
    staleTime: Infinity,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      ipc.createItem({
        itemType: "note",
        title: t("notes.untitled"),
        content: null,
        contentFormat: "markdown",
        priority: null,
        scheduled: null,
        due: null,
        reminderAt: null,
        projectId: null,
      }),
    onSuccess: (note) => setSelectedId(note.id),
    onError: reportError,
  });

  const list = notes.data ?? [];
  // 选中的被归档 / 删除后回落到最近更新的那一篇（渲染时推导，不在 Effect 里同步状态）。
  const activeId = list.find((note) => note.id === selectedId)?.id ?? list[0]?.id ?? null;

  return (
    <section aria-label={t("notes.label")} className="flex h-full min-w-0">
      <div className="flex w-72 shrink-0 flex-col border-r border-border bg-surface">
        <header className="flex items-center justify-between gap-2 px-4 py-3">
          <h1 className="text-lg font-semibold text-text">{t("shell.nav.notes")}</h1>
          <Button
            size="sm"
            variant="primary"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {t("notes.new")}
          </Button>
        </header>
        {notes.data === undefined ? null : list.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">{t("notes.empty.list")}</p>
        ) : (
          <ul
            aria-label={t("notes.listLabel")}
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
            // ↑ / ↓ 换到上一篇 / 下一篇，右边的编辑区跟着切换。
            onKeyDown={(event) => {
              if (moveFocusWithArrows(event, "[data-note-item]")) {
                (document.activeElement as HTMLElement | null)?.click();
              }
            }}
          >
            {list.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  data-note-item=""
                  aria-current={note.id === activeId ? "true" : undefined}
                  onClick={() => setSelectedId(note.id)}
                  className={cx(
                    "flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left",
                    "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
                    note.id === activeId ? "bg-primary/10" : "hover:bg-surface-hover",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-text">{note.title}</span>
                    <time
                      dateTime={note.updatedAt}
                      className="shrink-0 text-xs text-muted tabular-nums"
                    >
                      {distanceToNow(parseISO(note.updatedAt))}
                    </time>
                  </span>
                  <span className="truncate text-xs text-muted">
                    {noteSnippet(note.content) || t("notes.noContent")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {activeId === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            {notes.data !== undefined && (
              <>
                <p className="text-base font-medium text-text">{t("notes.empty.title")}</p>
                <p className="max-w-sm text-sm text-muted">{t("notes.empty.hint")}</p>
                <Button
                  variant="primary"
                  disabled={create.isPending}
                  onClick={() => create.mutate()}
                >
                  {t("notes.new")}
                </Button>
              </>
            )}
          </div>
        ) : (
          <NoteEditor key={activeId} id={activeId} />
        )}
      </div>
    </section>
  );
}
