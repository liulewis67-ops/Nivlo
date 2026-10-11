import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import type { ItemDto, ItemTypeDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { highlight, searchTerms, snippetAround } from "./model/highlight";
import type { Segment } from "./model/highlight";

/** 停止输入多久之后才发起搜索（毫秒）。 */
export const SEARCH_DEBOUNCE_MS = 140;

/** 结果分组的顺序（产品文档 §23：待办、笔记、提示）。 */
const GROUP_ORDER: ItemTypeDto[] = ["todo", "note", "tip"];

/** [`CommandPalette`] 的 Props。 */
export type CommandPaletteProps = {
  /** 关闭面板。 */
  onClose: () => void;
  /** 选中一条结果（回车或点击）；调用后面板自动关闭。 */
  onOpenItem: (id: string) => void;
};

/** 一个分组：类型与其中的结果（保持后端给出的相关度顺序）。 */
type Group = { type: ItemTypeDto; items: ItemDto[] };

/**
 * 把结果按类型分组；组内保持原有顺序，空组不出现。
 *
 * @param items 搜索结果（已按相关度排序）。
 * @returns 分组。
 */
function groupByType(items: readonly ItemDto[]): Group[] {
  return GROUP_ORDER.map((type) => ({
    type,
    items: items.filter((item) => item.itemType === type),
  })).filter((group) => group.items.length > 0);
}

/** [`Marked`] 的 Props。 */
type MarkedProps = {
  /** 切好的片段。 */
  segments: readonly Segment[];
};

/**
 * 渲染带高亮的文字：命中的部分加粗并着色。
 *
 * @param props 片段。
 * @returns 行内元素。
 */
function Marked({ segments }: MarkedProps) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-sm bg-primary/15 font-medium text-primary">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** 类型的小图标（线性，和侧栏风格一致）。 */
function TypeGlyph({ type }: { type: ItemTypeDto }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-4 shrink-0 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {type === "todo" && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
          <path d="M5.5 8.2l1.8 1.8 3.2-3.6" />
        </>
      )}
      {type === "note" && (
        <>
          <path d="M4 2.5h6l2.5 2.5v8a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5z" />
          <path d="M5.8 7.5h4.4M5.8 10h4.4" />
        </>
      )}
      {type === "tip" && (
        <>
          <path d="M8 2.5a4 4 0 0 0-2.2 7.3c.5.4.7.8.7 1.2h3c0-.4.2-.8.7-1.2A4 4 0 0 0 8 2.5z" />
          <path d="M6.5 13h3" />
        </>
      )}
    </svg>
  );
}

/**
 * 全局搜索面板（实施计划 3.4，Ctrl+K 打开）。
 *
 * * 输入后稍作停顿再搜索（[`SEARCH_DEBOUNCE_MS`]），结果按类型分组，命中的文字高亮，
 *   并附带正文里命中位置附近的一小段；
 * * 全键盘：↑ / ↓ 选择（首尾循环），回车打开，Esc 关闭；鼠标移过也会选中，点击打开；
 * * 打开时输入框聚焦，关闭时焦点回到打开之前的元素；
 * * 点击面板外的遮罩关闭。
 *
 * @param props 关闭与打开回调。
 * @returns 对话框。
 */
export function CommandPalette({ onClose, onOpenItem }: CommandPaletteProps) {
  const { t } = useTranslation();
  const listId = useId();
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const previouslyFocused = useRef<Element | null>(document.activeElement);
  const activeRef = useRef<HTMLLIElement | null>(null);

  // 输入停顿之后才更新查询，避免每个字符都打一次后端。
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // 关闭时把焦点还给打开之前的元素。
  useEffect(() => {
    const target = previouslyFocused.current;
    return () => {
      if (target instanceof HTMLElement) target.focus();
    };
  }, []);

  const search = useQuery({
    queryKey: queryKeys.search(debounced),
    queryFn: () => ipc.searchItems(debounced),
    enabled: debounced !== "",
    staleTime: Infinity,
  });
  const terms = searchTerms(debounced);
  const groups = debounced === "" ? [] : groupByType(search.data ?? []);
  // 展示顺序（分组后）的扁平列表，键盘选择按它走。
  const flat = groups.flatMap((group) => group.items);
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const activeItem = activeIndex >= 0 ? flat[activeIndex] : undefined;

  // 选中项滚进可见区域。
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeItem?.id]);

  /**
   * 选中一条结果：打开并关闭面板。
   *
   * @param id 条目 ID。
   */
  function choose(id: string): void {
    onOpenItem(id);
    onClose();
  }

  /**
   * 键盘：↑↓ 循环选择，回车打开，Esc 关闭。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" && flat.length > 0) {
      event.preventDefault();
      setActive((activeIndex + 1) % flat.length);
    } else if (event.key === "ArrowUp" && flat.length > 0) {
      event.preventDefault();
      setActive((activeIndex - 1 + flat.length) % flat.length);
    } else if (event.key === "Enter" && activeItem !== undefined) {
      event.preventDefault();
      choose(activeItem.id);
    }
  }

  const settled = debounced !== "" && search.data !== undefined && debounced === text.trim();
  return (
    <div
      className="nv-drop-zone fixed inset-0 z-(--nv-z-dialog) flex items-start justify-center bg-text/30 px-4 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("search.label")}
        onKeyDown={handleKeyDown}
        className="nv-panel-in flex max-h-[min(34rem,72vh)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-4 shrink-0 text-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            autoFocus
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              activeItem === undefined ? undefined : `${listId}-${activeItem.id}`
            }
            aria-label={t("search.input")}
            placeholder={t("search.placeholder")}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setActive(0);
            }}
            className="h-12 min-w-0 flex-1 bg-transparent text-base text-text placeholder:text-muted focus-visible:outline-none"
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted">
            {"Esc"}
          </kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {debounced === "" && (
            <p className="px-6 py-8 text-center text-sm text-muted">{t("search.hint")}</p>
          )}
          {settled && flat.length === 0 && (
            <p role="status" className="px-6 py-8 text-center text-sm text-muted">
              {t("search.empty", { query: debounced })}
            </p>
          )}
          {flat.length > 0 && (
            <ul id={listId} role="listbox" aria-label={t("search.results")} className="p-2">
              {groups.map((group) => (
                <li key={group.type} role="presentation">
                  <p
                    id={`${listId}-group-${group.type}`}
                    className="px-2 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted"
                  >
                    {t(`search.group.${group.type}`)}
                  </p>
                  <ul role="group" aria-labelledby={`${listId}-group-${group.type}`}>
                    {group.items.map((item) => {
                      const selected = item.id === activeItem?.id;
                      const snippet = snippetAround(item.content, terms);
                      return (
                        <li
                          key={item.id}
                          id={`${listId}-${item.id}`}
                          ref={selected ? activeRef : undefined}
                          role="option"
                          aria-selected={selected}
                          onMouseMove={() => setActive(flat.indexOf(item))}
                          onClick={() => choose(item.id)}
                          className={cx(
                            "flex cursor-pointer items-start gap-3 rounded-md px-3 py-2",
                            selected ? "bg-primary/10" : "hover:bg-surface-hover",
                          )}
                        >
                          <span className="pt-0.5">
                            <TypeGlyph type={item.itemType} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className={cx(
                                "block truncate text-sm text-text",
                                item.status === "done" && "text-muted line-through",
                              )}
                            >
                              <Marked segments={highlight(item.title, terms)} />
                            </span>
                            {snippet !== "" && (
                              <span className="mt-0.5 block truncate text-xs text-muted">
                                <Marked segments={highlight(snippet, terms)} />
                              </span>
                            )}
                          </span>
                          {selected && (
                            <kbd className="mt-0.5 shrink-0 rounded border border-border px-1.5 text-[11px] text-muted">
                              {"↵"}
                            </kbd>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted">
          <span>{t("search.keys")}</span>
          {settled && flat.length > 0 && (
            <span className="tabular-nums">{t("search.count", { count: flat.length })}</span>
          )}
        </footer>
      </div>
    </div>
  );
}
