import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Menu } from "@/components";
import { usePasteCapture } from "@/features/capture";
import type { ItemTypeDto } from "@/lib/ipc";
import { useInboxQuery } from "./api";
import { InboxRow } from "./InboxRow";
import { pruneSelection, selectRange } from "./model/inbox-entry";
import { useOrganize } from "./useOrganize";
import type { OrganizeKind } from "./useOrganize";

/** 批量「转换类型」菜单里的类型。 */
const CONVERT_KINDS: ItemTypeDto[] = ["todo", "note", "tip"];

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
  const paste = usePasteCapture();

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

  const order = entries?.map((entry) => entry.item.id) ?? [];
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
    const only = ids.length === 1 ? entries?.find((e) => e.item.id === ids[0]) : undefined;
    setSelected(new Set());
    void organize(ids, kind, only?.item.title);
  }

  /**
   * Escape 清除选择。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape" && selected.size > 0) {
      event.stopPropagation();
      setSelected(new Set());
    }
  }

  const count = entries?.length ?? 0;
  const selectedIds = order.filter((id) => selected.has(id));

  return (
    <section
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
        {count > 0 && (
          <div
            className="flex min-h-9 items-center gap-2"
            role="toolbar"
            aria-label={t("inbox.toolbar.label")}
          >
            <label className="flex cursor-pointer items-center gap-2 pl-3 text-sm text-muted">
              <input
                type="checkbox"
                checked={selected.size === count}
                ref={(node) => {
                  if (node !== null)
                    node.indeterminate = selected.size > 0 && selected.size < count;
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
                <Button size="sm" onClick={() => run(selectedIds, "today")}>
                  {t("inbox.action.today")}
                </Button>
                <Button size="sm" onClick={() => run(selectedIds, "tomorrow")}>
                  {t("inbox.action.tomorrow")}
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
              </div>
            )}
          </div>
        )}
      </header>
      {count > 0 && entries !== undefined ? (
        <div className="min-h-0 flex-1 overflow-y-auto pb-6">
          <ul className="mx-auto w-full max-w-3xl px-5">
            {entries.map((entry) => (
              <InboxRow
                key={entry.item.id}
                entry={entry}
                selected={selected.has(entry.item.id)}
                onToggle={(range) => toggle(entry.item.id, range)}
                onOrganize={(kind) => run([entry.item.id], kind)}
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
