import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { useProjectsQuery } from "@/features/organize";
import { parseDatePhrase } from "@/features/quick-create";
import type { DatePhraseResult } from "@/features/quick-create";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import type { ItemDto, ItemTypeDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { highlight, searchTerms, snippetAround } from "./model/highlight";
import type { Segment } from "./model/highlight";
import { itemMeta } from "./model/meta";

/** 停止输入多久之后才发起搜索（毫秒）。 */
export const SEARCH_DEBOUNCE_MS = 140;

/** 输入为空时列出多少条最近更新的条目。 */
export const RECENT_LIMIT = 8;

/** 结果分组的顺序（产品文档 §23：待办、笔记、提示）。 */
const GROUP_ORDER: ItemTypeDto[] = ["todo", "note", "tip"];

/** [`SearchPanel`] 的 Props。 */
export type SearchPanelProps = {
  /** 关闭（Esc）。 */
  onClose: () => void;
  /** 选中一条结果（回车或点击）。 */
  onOpenItem: (id: string) => void;
  /**
   * 外观：`dialog` 是主窗口里的浮层（自带圆角边框）；`window` 填满独立的全局搜索窗口
   * （圆角与阴影由系统窗口提供），输入框更大。
   */
  variant?: "dialog" | "window";
  /** 输入框为空、也还没有任何条目可列出时显示的提示，缺省为通用的搜索说明。 */
  emptyHint?: ReactNode;
  /** 输入为空时底部右侧的附加内容（如全局快捷键提示）。 */
  footerExtra?: ReactNode;
  /**
   * 从搜索创建的待办建好之后调用。提供时才能从搜索直接创建：Ctrl+Enter，或者没有结果时
   * 点「新建待办」；标题里的日期短语（「明天」「周五 3pm」）按 Quick Create 的规则识别。
   */
  onCreated?: (item: ItemDto) => void;
};

/** 从搜索词新建待办的草稿。 */
type Draft = {
  /** 去掉日期短语之后的标题。 */
  title: string;
  /** 识别出的计划；没有时由后端按 Quick Create 的默认值（今天）处理。 */
  schedule: DatePhraseResult["schedule"] | null;
  /** 识别出的计划的说明，如「明天 · 10月28日 周三」。 */
  label: string | null;
};

/**
 * 把搜索词变成待办草稿：识别日期短语，识别不到就原样作为标题。
 *
 * @param query 搜索词（已去掉首尾空白，非空）。
 * @returns 草稿。
 */
function draftFrom(query: string): Draft {
  const parsed = parseDatePhrase(query, format(new Date(), "yyyy-MM-dd"));
  return parsed === null
    ? { title: query, schedule: null, label: null }
    : { title: parsed.title, schedule: parsed.schedule, label: parsed.label };
}

/**
 * 一个分组：类型与其中的结果（保持后端给出的相关度顺序）；输入为空时只有一组 `recent`，
 * 即最近更新的条目。
 */
type Group = { key: ItemTypeDto | "recent"; items: ItemDto[] };

/**
 * 把结果按类型分组；组内保持原有顺序，空组不出现。
 *
 * @param items 搜索结果（已按相关度排序）。
 * @returns 分组。
 */
function groupByType(items: readonly ItemDto[]): Group[] {
  return GROUP_ORDER.map((type) => ({
    key: type,
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
 * 搜索面板：主窗口的 Ctrl+K 浮层与全局搜索窗口共用（实施计划 3.4）。
 *
 * * 输入后稍作停顿再搜索（[`SEARCH_DEBOUNCE_MS`]），结果按类型分组，命中的文字高亮，
 *   并附带正文里命中位置附近的一小段；
 * * 全键盘：↑ / ↓ 选择（首尾循环），Home / End 跳到首尾，回车打开，Esc 关闭；
 *   鼠标移过也会选中，点击打开；
 * * 输入还没停顿就按回车时，等这次搜索出结果后再打开第一条，不会因为手快而落空；
 * * 输入为空时列出最近更新的几条（[`RECENT_LIMIT`]），直接 ↑ / ↓ + 回车就能打开，
 *   不必先想关键词；
 * * 提供 `onCreated` 时，Ctrl+Enter 把搜索词直接建成待办（没有结果时还会给出按钮），
 *   找不到就顺手记下，不必换到别的入口；
 * * 挂载时输入框聚焦；重置（清空输入）由调用方用 `key` 重新挂载完成。
 *
 * @param props 关闭与打开回调、外观。
 * @returns 面板内容（不含遮罩）。
 */
export function SearchPanel({
  onClose,
  onOpenItem,
  variant = "dialog",
  emptyHint,
  footerExtra,
  onCreated,
}: SearchPanelProps) {
  const { t } = useTranslation();
  const listId = useId();
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  /** 用户在结果出来之前按了回车：结果一到就打开选中的那一条。 */
  const openWhenReady = useRef(false);
  const activeRef = useRef<HTMLLIElement | null>(null);

  // 输入停顿之后才更新查询，避免每个字符都打一次后端。
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const search = useQuery({
    queryKey: queryKeys.search(debounced),
    queryFn: () => ipc.searchItems(debounced),
    enabled: debounced !== "",
    staleTime: Infinity,
    // 继续输入时先保留上一次的结果，新结果到了再替换，列表不会闪一下空白。
    placeholderData: keepPreviousData,
  });
  const projects = useProjectsQuery();
  const projectNames = new Map(projects.data?.map((project) => [project.id, project.name]));
  const today = new Date();
  const recent = useQuery({
    queryKey: queryKeys.searchRecent(),
    queryFn: () =>
      ipc.listItems({
        itemType: null,
        includeArchived: false,
        orderBy: "updated",
        limit: RECENT_LIMIT,
      }),
  });
  const query = text.trim();
  /** 输入为空：浏览最近的条目。 */
  const browsing = query === "";
  // 刚开始输入、第一次搜索的结果还没到时继续显示最近条目，避免列表闪一下空白。
  const showRecent = browsing || debounced === "" || search.data === undefined;
  const recentItems = recent.data ?? [];
  const terms = showRecent ? [] : searchTerms(debounced);
  const groups: Group[] = showRecent
    ? recentItems.length > 0
      ? [{ key: "recent", items: recentItems }]
      : []
    : groupByType(search.data ?? []);
  // 展示顺序（分组后）的扁平列表，键盘选择按它走。
  const flat = groups.flatMap((group) => group.items);
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const activeItem = activeIndex >= 0 ? flat[activeIndex] : undefined;
  const draft = onCreated === undefined || browsing ? null : draftFrom(query);
  const create = useMutation({
    mutationFn: (value: Draft) => ipc.quickCreate("todo", value.title, value.schedule),
    onSuccess: (item) => onCreated?.(item),
    onError: reportError,
  });

  /** 用当前搜索词新建待办（正在创建时忽略重复触发）。 */
  function createDraft(): void {
    if (draft !== null && !create.isPending) create.mutate(draft);
  }

  /** 列表与输入一致，可以直接打开选中项。 */
  const settled = browsing
    ? recent.data !== undefined
    : debounced !== "" &&
      search.data !== undefined &&
      !search.isPlaceholderData &&
      debounced === query;

  // 选中项滚进可见区域。
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeItem?.id]);

  // 提前按下的回车：这次输入的结果到了就打开第一条；没有结果就作罢。
  useEffect(() => {
    if (!openWhenReady.current || !settled) return;
    openWhenReady.current = false;
    if (activeItem !== undefined) onOpenItem(activeItem.id);
  }, [settled, activeItem, onOpenItem]);

  /**
   * 键盘：↑↓ 循环选择，Home / End 首尾，回车打开，Esc 关闭。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.nativeEvent.isComposing) return;
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
    } else if (
      (event.key === "PageDown" || event.key === "End") &&
      event.ctrlKey &&
      flat.length > 0
    ) {
      event.preventDefault();
      setActive(flat.length - 1);
    } else if (
      (event.key === "PageUp" || event.key === "Home") &&
      event.ctrlKey &&
      flat.length > 0
    ) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      openWhenReady.current = false;
      createDraft();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (settled && activeItem !== undefined) onOpenItem(activeItem.id);
      else if (!settled && !browsing) openWhenReady.current = true;
    }
  }

  const isWindow = variant === "window";
  return (
    <div
      onKeyDown={handleKeyDown}
      className={cx(
        "flex flex-col overflow-hidden bg-surface",
        isWindow
          ? "h-full w-full"
          : "nv-panel-in max-h-[min(34rem,72vh)] w-full max-w-xl rounded-xl border border-border shadow-lg",
      )}
    >
      <div
        className={cx("flex items-center gap-3 border-b border-border", isWindow ? "px-5" : "px-4")}
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className={cx("shrink-0 text-muted", isWindow ? "size-5" : "size-4")}
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
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            openWhenReady.current = false;
          }}
          className={cx(
            "min-w-0 flex-1 bg-transparent text-text placeholder:text-muted focus-visible:outline-none",
            isWindow ? "h-14 text-lg" : "h-12 text-base",
          )}
        />
        {text !== "" && search.isFetching && (
          <span
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary"
          />
        )}
        <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted">
          {"Esc"}
        </kbd>
      </div>
      <div className="nv-scroll-hover min-h-0 flex-1 overflow-y-auto">
        {showRecent && recentItems.length === 0 && !recent.isLoading && (
          <p className="px-6 py-8 text-center text-sm text-muted">
            {emptyHint ?? t("search.hint")}
          </p>
        )}
        {!browsing && settled && flat.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-6 py-8">
            <p role="status" className="text-center text-sm text-muted">
              {t("search.empty", { query: debounced })}
            </p>
            {draft !== null && (
              <Button size="sm" disabled={create.isPending} onClick={createDraft}>
                <span className="truncate">{t("search.create", { title: draft.title })}</span>
                {draft.label !== null && <span className="text-muted">{draft.label}</span>}
                <kbd className="rounded border border-border px-1 text-[11px] text-muted">
                  {"Ctrl+↵"}
                </kbd>
              </Button>
            )}
          </div>
        )}
        {flat.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            aria-label={showRecent ? t("search.recent") : t("search.results")}
            className="p-2"
          >
            {groups.map((group) => (
              <li key={group.key} role="presentation">
                <p
                  id={`${listId}-group-${group.key}`}
                  className="px-2 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted"
                >
                  {group.key === "recent" ? t("search.recent") : t(`search.group.${group.key}`)}
                </p>
                <ul role="group" aria-labelledby={`${listId}-group-${group.key}`}>
                  {group.items.map((item) => {
                    const selected = item.id === activeItem?.id;
                    const snippet = snippetAround(item.content, terms);
                    const meta = itemMeta(item, today, (id) => projectNames.get(id));
                    return (
                      <li
                        key={item.id}
                        id={`${listId}-${item.id}`}
                        ref={selected ? activeRef : undefined}
                        role="option"
                        aria-selected={selected}
                        onMouseMove={() => setActive(flat.indexOf(item))}
                        onClick={() => onOpenItem(item.id)}
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
                        {meta.length > 0 && (
                          <span className="mt-0.5 max-w-[40%] shrink-0 truncate text-xs text-muted">
                            {meta.join(" · ")}
                          </span>
                        )}
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
      <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted">
        <span>{t("search.keys")}</span>
        <span className="flex items-center gap-3">
          {/* 结果数量兼作读屏播报：元素一直存在、只更新文字（新插入的 live 区域常常不会被播报）。 */}
          <span role="status" className="tabular-nums empty:hidden">
            {!showRecent && settled && flat.length > 0
              ? t("search.count", { count: flat.length })
              : ""}
          </span>
          {draft !== null && flat.length > 0 && <span>{t("search.createHint")}</span>}
          {browsing && footerExtra}
        </span>
      </footer>
    </div>
  );
}
