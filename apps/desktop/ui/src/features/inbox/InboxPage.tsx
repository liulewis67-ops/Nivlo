import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Menu } from "@/components";
import { usePasteCapture } from "@/features/capture";
import { useOpenItem } from "@/features/detail";
import type { ItemTypeDto } from "@/lib/ipc";
import { filterWords, matchesAllWords } from "@/lib/text-filter";
import { isCommandKey, isDialogOpen } from "@/lib/typing";
import { moveFocusWithArrows, nextRemaining } from "@/lib/arrow-focus";
import { useInboxQuery } from "./api";
import { InboxRow } from "./InboxRow";
import { entrySearchText, pruneSelection, selectRange } from "./model/inbox-entry";
import { useOrganize } from "./useOrganize";
import { useDeleteItems } from "@/features/trash";
import type { OrganizeKind } from "./useOrganize";

/** 批量「转换类型」菜单里的类型。 */
const CONVERT_KINDS: ItemTypeDto[] = ["todo", "note", "tip"];

/** 收集箱里有这么多条时才显示筛选框。 */
export const INBOX_FILTER_MIN = 10;

/**
 * 主窗口的 Inbox 视图（实施计划 2.7、产品文档 §8）：捕获来的东西先落在这里，一两下整理走。
 *
 * * 每行悬停（或键盘聚焦）出现「今天 / 明天 / 更多」；
 * * 勾选多行（Shift 点击选范围）后出现批量工具栏，一次整理一批，整批是一个事务；
 * * 每次整理都有可撤销的 Toast，撤销把条目精确放回收集箱；
 * * 空了就告诉用户怎么往里放东西，而不是一块空白。
 *
 * @returns Inbox 页面。
 */
export function InboxPage() {
  const { t } = useTranslation();
  const entries = useInboxQuery().data;
  const { organize } = useOrganize();
  const { remove } = useDeleteItems();
  const paste = usePasteCapture();
  const openItem = useOpenItem();

  // Ctrl+V（macOS 为 Cmd+V）：焦点不在输入框里时，把剪贴板收进 Inbox。
  // 只响应用户按下的粘贴快捷键，没有任何监听剪贴板的行为。
  useEffect(() => {
    /**
     * 全局按键：粘贴快捷键且不是在可编辑元素里时触发粘贴捕获。
     *
     * @param event 键盘事件。
     */
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || event.key.toLowerCase() !== "v") return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      void paste();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paste]);
  const [picked, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  /** 整理之后要聚焦的那一行（整理前焦点在列表里时才有）；列表更新后由下面的 Effect 聚焦。 */
  const refocusId = useRef<string | null>(null);

  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  // Ctrl+F（macOS ⌘F）跳到筛选框（与笔记页一致）；筛选框没显示（条目少）时留给页内查找。
  useEffect(() => {
    /**
     * 跳到筛选框的快捷键。
     *
     * @param event 键盘事件。
     */
    function handleFind(event: globalThis.KeyboardEvent): void {
      const box = filterRef.current;
      if (!isCommandKey(event, "f") || box === null || isDialogOpen()) return;
      event.preventDefault();
      box.focus();
      box.select();
    }
    window.addEventListener("keydown", handleFind);
    return () => window.removeEventListener("keydown", handleFind);
  }, []);
  const words = filterWords(filter);
  const searchTexts = useMemo(
    () => new Map((entries ?? []).map((entry) => [entry.item.id, entrySearchText(entry)])),
    [entries],
  );
  // 筛选时只显示、只选择、只整理匹配的条目：看不见的不会被一起整理掉。
  const shown =
    words.length === 0
      ? (entries ?? [])
      : (entries ?? []).filter((entry) =>
          matchesAllWords(searchTexts.get(entry.item.id) ?? "", words),
        );
  const order = shown.map((entry) => entry.item.id);
  // 条目被整理走（或在别处变化）后，已经不在列表里的选中项不再算数（渲染时推导，不在 Effect 里同步状态）。
  const selected = pruneSelection(picked, order);

  /**
   * 切换一行的选中状态；按住 Shift 时选中它与上次点击之间的整段。
   *
   * @param id 被点击的 Item ID。
   * @param range 是否按住了 Shift。
   */
  function toggle(id: string, range: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (range && anchor !== null) {
        for (const rangeId of selectRange(order, anchor, id)) next.add(rangeId);
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setAnchor(id);
  }

  /** 全选 / 取消全选。 */
  function toggleAll(): void {
    setSelected(selected.size === order.length ? new Set() : new Set(order));
  }

  /**
   * 对一批 Item 整理；单条时带上标题用于 Toast 文案。
   *
   * @param ids 被整理的 Item ID。
   * @param kind 整理种类。
   */
  function run(ids: string[], kind: OrganizeKind): void {
    // 被整理的行会立刻消失，焦点随之丢到页面上：改为落在后面紧接着的一行（没有就是前面一行），
    // 键盘整理可以接着 ↓ 空格 T，不用重新找位置。
    if (sectionRef.current?.contains(document.activeElement) === true) {
      refocusId.current = nextRemaining(order, ids);
    }
    const only = ids.length === 1 ? entries?.find((e) => e.item.id === ids[0]) : undefined;
    setSelected(new Set());
    void organize(ids, kind, only?.item.title);
  }

  /**
   * 删除一批条目（移进回收站，带撤销）；焦点同样落到接下来的那一行。
   *
   * @param ids 要删除的 Item ID。
   * @param title 单条时的标题，用于提示文案。
   */
  function deleteItems(ids: string[], title?: string): void {
    if (sectionRef.current?.contains(document.activeElement) === true) {
      refocusId.current = nextRemaining(order, ids);
    }
    setSelected(new Set());
    void remove(ids, title);
  }

  /**
   * 键盘整理：↑ / ↓ 在条目之间移动，Ctrl+A 全选，选中条目后按 T 安排到今天、M 安排到明天、
   * Delete 删除（和点按钮一样，带撤销）；Escape 清除选择。
   * 在文字输入框里不响应（勾选框除外：选中条目就是在它上面按空格）。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape" && selected.size > 0) {
      event.stopPropagation();
      setSelected(new Set());
      return;
    }
    // ↑ / ↓ 在各条的勾选框之间移动（不用 Tab 穿过每一行的按钮）：↓ ↓ 空格 T 就能整理。
    if (moveFocusWithArrows(event, "[data-inbox-select]")) return;
    // 勾选框上按 Enter 打开详情（和「今天」一致；勾选用空格）。
    const box = event.target;
    if (
      event.key === "Enter" &&
      openItem !== null &&
      box instanceof HTMLElement &&
      box.dataset.itemId !== undefined &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      openItem(box.dataset.itemId);
      return;
    }
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "TEXTAREA" ||
        (target instanceof HTMLInputElement && target.type !== "checkbox"));
    if (typing) return;
    // Ctrl+A（macOS ⌘A）选中全部条目，而不是选中页面上的文字。
    if (isCommandKey(event, "a") && order.length > 0) {
      event.preventDefault();
      setSelected(new Set(order));
      return;
    }
    if (selected.size === 0 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Delete") {
      event.preventDefault();
      deleteItems(selectedIds);
      return;
    }
    const key = event.key.toLowerCase();
    const kind: OrganizeKind | null = key === "t" ? "today" : key === "m" ? "tomorrow" : null;
    if (kind === null) return;
    event.preventDefault();
    run(selectedIds, kind);
  }

  // 列表更新（整理的行已移除）后把焦点放到记下的那一行。只操作 DOM，不改状态。
  useEffect(() => {
    const id = refocusId.current;
    if (id === null) return;
    const box = [
      ...(sectionRef.current?.querySelectorAll<HTMLElement>("[data-inbox-select]") ?? []),
    ].find((element) => element.dataset.itemId === id);
    if (box === undefined) return;
    refocusId.current = null;
    box.focus();
  }, [entries]);

  const count = entries?.length ?? 0;
  const selectedIds = order.filter((id) => selected.has(id));

  return (
    <section
      ref={sectionRef}
      aria-label={t("inbox.page.label")}
      onKeyDown={handleKeyDown}
      className="flex h-full flex-col"
    >
      <header className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-8 pt-7 pb-3">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold text-text">{t("shell.nav.inbox")}</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted tabular-nums">
              {count === 0 ? t("inbox.page.allClear") : t("inbox.page.pending", { count })}
            </span>
            <Button size="sm" onClick={() => void paste()}>
              {t("capture.paste")}
            </Button>
          </div>
        </div>
        {/* 条目多了才出现（筛选中一直显示）：按标题、正文、来源网址 / 文件、来源应用筛选。 */}
        {(count >= INBOX_FILTER_MIN || filter !== "") && (
          <Input
            ref={filterRef}
            aria-keyshortcuts="Control+F"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter !== "") {
                event.preventDefault();
                event.stopPropagation();
                setFilter("");
              } else if (event.key === "ArrowDown") {
                const first = sectionRef.current?.querySelector<HTMLElement>("[data-inbox-select]");
                if (first === null || first === undefined) return;
                event.preventDefault();
                first.focus();
              }
            }}
            aria-label={t("inbox.filter")}
            placeholder={t("inbox.filter")}
            className="h-8"
          />
        )}
        {count > 0 && (
          <div
            className="flex min-h-9 items-center gap-2"
            role="toolbar"
            aria-label={t("inbox.toolbar.label")}
          >
            <label className="flex cursor-pointer items-center gap-2 pl-3 text-sm text-muted">
              <input
                type="checkbox"
                checked={order.length > 0 && selected.size === order.length}
                ref={(node) => {
                  if (node !== null)
                    node.indeterminate = selected.size > 0 && selected.size < order.length;
                }}
                onChange={toggleAll}
                className="size-4 cursor-pointer accent-primary"
              />
              {selected.size === 0
                ? t("inbox.toolbar.selectAll")
                : t("inbox.toolbar.selected", { count: selected.size })}
            </label>
            {selected.size > 0 && (
              <div className="ml-auto flex items-center gap-1">
                {/* 按钮里标出对应的按键（T / M / Delete），用着用着就记住了。 */}
                <Button size="sm" aria-keyshortcuts="T" onClick={() => run(selectedIds, "today")}>
                  {t("inbox.action.today")}
                  <kbd aria-hidden="true" className="ml-1.5 text-[10px] text-muted">
                    {"T"}
                  </kbd>
                </Button>
                <Button
                  size="sm"
                  aria-keyshortcuts="M"
                  onClick={() => run(selectedIds, "tomorrow")}
                >
                  {t("inbox.action.tomorrow")}
                  <kbd aria-hidden="true" className="ml-1.5 text-[10px] text-muted">
                    {"M"}
                  </kbd>
                </Button>
                <Button size="sm" onClick={() => run(selectedIds, "later")}>
                  {t("inbox.action.later")}
                </Button>
                <Menu
                  trigger={
                    <Button size="sm" variant="ghost">
                      {t("inbox.action.convertMenu")}
                    </Button>
                  }
                  items={CONVERT_KINDS.map((kind) => ({
                    id: kind,
                    label: t(`quickCreate.kind.${kind}`),
                    onSelect: () => run(selectedIds, kind),
                  }))}
                />
                <Button size="sm" variant="ghost" onClick={() => run(selectedIds, "leave")}>
                  {t("inbox.action.leave")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => run(selectedIds, "archive")}>
                  {t("inbox.action.archive")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  aria-keyshortcuts="Delete"
                  onClick={() => deleteItems(selectedIds)}
                >
                  {t("trash.delete")}
                  <kbd aria-hidden="true" className="ml-1.5 text-[10px] text-muted">
                    {"Del"}
                  </kbd>
                </Button>
              </div>
            )}
          </div>
        )}
      </header>
      {count > 0 && entries !== undefined ? (
        <div className="min-h-0 flex-1 overflow-y-auto pb-6">
          {shown.length === 0 && (
            <p role="status" className="px-8 py-6 text-center text-sm text-muted">
              {t("inbox.noMatch")}
            </p>
          )}
          <ul className="mx-auto w-full max-w-3xl px-5">
            {shown.map((entry) => (
              <InboxRow
                key={entry.item.id}
                entry={entry}
                selected={selected.has(entry.item.id)}
                onToggle={(range) => toggle(entry.item.id, range)}
                onOrganize={(kind) => run([entry.item.id], kind)}
                onDelete={() => deleteItems([entry.item.id], entry.item.title)}
              />
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 pb-16 text-center">
          {entries !== undefined && (
            <>
              <p className="text-base font-medium text-text">{t("inbox.empty.title")}</p>
              <p className="max-w-sm text-sm text-muted">{t("inbox.empty.hint")}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
