import { useMutation, useQuery } from "@tanstack/react-query";
import { parseISO } from "date-fns";
import { distanceToNow } from "@/lib/date-format";
import { isCommandKey, isDialogOpen } from "@/lib/typing";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@/components";
import { useNavStore } from "@/features/shell";
import { moveFocusWithArrows, nextRemaining } from "@/lib/arrow-focus";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { filterWords, noteSearchText } from "./model/note-filter";
import { noteSnippet } from "./model/note-snippet";
import { NoteEditor } from "./NoteEditor";

/**
 * 主窗口的 Notes 视图（实施计划 3.2、产品文档 §17「快速记录、基本编辑」）：
 * 左边是最近更新的笔记，右边是编辑区。
 *
 * * 「+ 新笔记」（或 Ctrl+N）立刻创建一篇并打开，标题已选中，直接打字即可（先创建，再整理）；
 * * 编辑区自动保存（同详情面板，保存失败不丢内容）；
 * * 归档带可撤销的提示；
 * * 没有选中时默认打开最近更新的那一篇，一篇都没有时引导用户新建；
 * * 列表上方的筛选框按标题与内容筛选（不切换正在编辑的笔记）；在筛选框里按 ↓ 或 Enter 打开第一篇，Esc 清空。
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
  // 打开的笔记放在导航 Store 里：离开 Notes 再回来仍是这一篇，Ctrl+K「新建笔记」也能直接打开。
  const selectedId = useNavStore((state) => state.noteId);
  const freshId = useNavStore((state) => state.freshNoteId);
  const openNote = useNavStore((state) => state.openNote);
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  /** 归档 / 删除之后要聚焦的那一篇；列表更新后由下面的 Effect 聚焦。 */
  const refocusId = useRef<string | null>(null);

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
    onSuccess: (note) => openNote(note.id, true),
    onError: reportError,
  });

  // Ctrl+N（macOS ⌘N）新建一篇笔记（笔记应用的常见约定），在输入时也有效；Ctrl+F 跳到筛选框。
  // 有对话框打开时都不响应。
  const createNote = create.mutate;
  const creating = create.isPending;
  useEffect(() => {
    /**
     * 新建笔记的快捷键。
     *
     * @param event 键盘事件。
     */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (isDialogOpen()) return;
      if (isCommandKey(event, "n")) {
        event.preventDefault();
        if (!creating) createNote();
        return;
      }
      // Ctrl+F 跳到筛选框（列表上方）；在编辑区里时留给页内查找，方便在正文里找字。
      const filterBox = filterRef.current;
      const inEditor = document.activeElement?.closest("article") != null;
      if (isCommandKey(event, "f") && filterBox !== null && !inEditor) {
        event.preventDefault();
        filterBox.focus();
        filterBox.select();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createNote, creating]);

  const list = notes.data ?? [];
  // 选中的被归档 / 删除后回落到最近更新的那一篇（渲染时推导，不在 Effect 里同步状态）。
  const activeId = list.find((note) => note.id === selectedId)?.id ?? list[0]?.id ?? null;
  // 每篇的小写全文只在列表变化时算一次：上千篇长文时，逐字输入也不用每次把全部内容重新转小写。
  const searchTexts = useMemo(
    () => new Map((notes.data ?? []).map((note) => [note.id, noteSearchText(note)])),
    [notes.data],
  );
  const words = filterWords(filter);
  const visible =
    words.length === 0
      ? list
      : list.filter((note) => {
          const text = searchTexts.get(note.id) ?? "";
          return words.every((word) => text.includes(word));
        });

  // 归档 / 删除后这篇离开列表、编辑区换成另一篇，焦点会掉到页面上：改为落在列表里接下来的那一篇
  // （同时打开它），键盘用户可以接着 ↑ ↓。焦点已经在别处时不抢。只操作 DOM，不改状态。
  useEffect(() => {
    const id = refocusId.current;
    if (id === null) return;
    const button = [
      ...(listRef.current?.querySelectorAll<HTMLElement>("[data-note-item]") ?? []),
    ].find((element) => element.dataset.noteId === id);
    if (button === undefined) return;
    refocusId.current = null;
    if (document.activeElement === null || document.activeElement === document.body) {
      button.focus();
      button.click();
    }
  }, [notes.data]);

  /**
   * 筛选框的键盘：↓ / Enter 打开并聚焦第一篇匹配的笔记（之后可以继续用 ↑ ↓），Esc 清空筛选。
   *
   * @param event 键盘事件。
   */
  function handleFilterKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape" && filter !== "") {
      event.preventDefault();
      event.stopPropagation();
      setFilter("");
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      const first = listRef.current?.querySelector<HTMLElement>("[data-note-item]");
      if (first === null || first === undefined) return;
      event.preventDefault();
      first.focus();
      first.click();
    }
  }

  return (
    <section aria-label={t("notes.label")} className="flex h-full min-w-0">
      <div className="flex w-72 shrink-0 flex-col border-r border-border bg-surface">
        <header className="flex items-center justify-between gap-2 px-4 py-3">
          <h1 className="text-lg font-semibold text-text">{t("shell.nav.notes")}</h1>
          <Button
            size="sm"
            variant="primary"
            disabled={create.isPending}
            aria-keyshortcuts="Control+N"
            onClick={() => create.mutate()}
          >
            {t("notes.new")}
          </Button>
        </header>
        {list.length > 0 && (
          <div className="px-3 pb-2">
            <Input
              ref={filterRef}
              aria-keyshortcuts="Control+F"
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={handleFilterKeyDown}
              aria-label={t("notes.filter")}
              placeholder={t("notes.filter")}
              className="h-8"
            />
          </div>
        )}
        {notes.data === undefined ? null : list.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">{t("notes.empty.list")}</p>
        ) : visible.length === 0 ? (
          <p role="status" className="px-4 py-6 text-center text-sm text-muted">
            {t("notes.noMatch")}
          </p>
        ) : (
          <ul
            ref={listRef}
            aria-label={t("notes.listLabel")}
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
            // ↑ / ↓ 换到上一篇 / 下一篇，右边的编辑区跟着切换。
            onKeyDown={(event) => {
              if (moveFocusWithArrows(event, "[data-note-item]")) {
                (document.activeElement as HTMLElement | null)?.click();
              }
            }}
          >
            {visible.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  data-note-item=""
                  data-note-id={note.id}
                  aria-current={note.id === activeId ? "true" : undefined}
                  onClick={() => openNote(note.id)}
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
          <NoteEditor
            key={activeId}
            id={activeId}
            focusTitle={activeId === freshId}
            onLeave={() => {
              refocusId.current = nextRemaining(
                visible.map((note) => note.id),
                [activeId],
              );
            }}
          />
        )}
      </div>
    </section>
  );
}
