import { formatDistanceToNowStrict, parseISO } from "date-fns";
import { zhCN } from "date-fns/locale";
import { useTranslation } from "react-i18next";
import { Button, Menu } from "@/components";
import { useOpenItem } from "@/features/detail";
import type { MenuItemSpec } from "@/components";
import type { InboxEntryDto, ItemTypeDto } from "@/lib/ipc";
import { cx } from "@/lib/cx";
import { summarizeEntry } from "./model/inbox-entry";
import { SourceIcon } from "./SourceIcon";
import type { OrganizeKind } from "./useOrganize";

/** 三种可转换的类型，按展示顺序。 */
const CONVERT_KINDS: ItemTypeDto[] = ["todo", "note", "tip"];

/** [`InboxRow`] 的 Props。 */
export type InboxRowProps = {
  /** 这一行的条目。 */
  entry: InboxEntryDto;
  /** 是否被选中。 */
  selected: boolean;
  /** 点击选择框；`range` 为 `true` 表示按住了 Shift（范围选择）。 */
  onToggle: (range: boolean) => void;
  /** 对这一条执行整理动作。 */
  onOrganize: (kind: OrganizeKind) => void;
  /** 删除这一条（移进回收站）。 */
  onDelete: () => void;
};

/**
 * Inbox 里的一行：选择框、来源图标、标题与来源说明、捕获时间，以及悬停（或键盘聚焦）时出现的
 * 快速整理按钮（产品文档 §8：一两下就能把它放到该去的地方）。
 *
 * 被引用的文件不在原处时显示「文件不存在」徽标，而不是报错。
 *
 * @param props 条目、选中状态与回调。
 * @returns 列表项。
 */
export function InboxRow({ entry, selected, onToggle, onOrganize, onDelete }: InboxRowProps) {
  const { t } = useTranslation();
  const { item } = entry;
  const summary = summarizeEntry(entry);
  const openItem = useOpenItem();
  // 标题已经是文件名 / 网址时，不再重复显示同样的来源说明。
  const detail = [summary.detail, summary.app].filter(
    (part) => part !== null && part !== "" && part !== item.title,
  );

  const moreItems: MenuItemSpec[] = [
    { id: "later", label: t("inbox.action.later"), onSelect: () => onOrganize("later") },
    ...CONVERT_KINDS.filter((kind) => kind !== item.itemType).map((kind) => ({
      id: `convert-${kind}`,
      label: t("inbox.action.convert", { type: t(`quickCreate.kind.${kind}`) }),
      onSelect: () => onOrganize(kind),
    })),
    { id: "leave", label: t("inbox.action.leave"), onSelect: () => onOrganize("leave") },
    { id: "archive", label: t("inbox.action.archive"), onSelect: () => onOrganize("archive") },
    { id: "delete", label: t("trash.delete"), isDanger: true, onSelect: onDelete },
  ];

  return (
    <li
      className={cx(
        "group flex items-center gap-3 rounded-md px-3 py-2.5",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        selected ? "bg-primary/10" : "hover:bg-surface-hover",
      )}
    >
      <input
        type="checkbox"
        aria-label={t("inbox.select", { title: item.title })}
        checked={selected}
        onChange={() => undefined}
        onClick={(event) => onToggle(event.shiftKey)}
        className="size-4 shrink-0 cursor-pointer accent-primary"
      />
      <span className="text-muted">
        <SourceIcon kind={summary.kind} />
      </span>
      <div className="min-w-0 flex-1">
        {openItem === null ? (
          <p className="truncate text-sm font-medium text-text">{item.title}</p>
        ) : (
          <button
            type="button"
            onClick={() => openItem(item.id)}
            className="block w-full truncate text-left text-sm font-medium text-text hover:underline"
          >
            {item.title}
          </button>
        )}
        <p className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="shrink-0 rounded-sm bg-surface-hover px-1.5 py-0.5">
            {t(`quickCreate.kind.${item.itemType}`)}
          </span>
          {detail.length > 0 && <span className="truncate">{detail.join(" · ")}</span>}
          {summary.missingFile && (
            <span className="shrink-0 rounded-sm bg-danger/10 px-1.5 py-0.5 text-danger">
              {t("inbox.missingFile")}
            </span>
          )}
        </p>
      </div>
      <time
        dateTime={item.createdAt}
        className="shrink-0 text-xs text-muted tabular-nums group-hover:hidden group-focus-within:hidden"
      >
        {formatDistanceToNowStrict(parseISO(item.createdAt), { locale: zhCN, addSuffix: true })}
      </time>
      <div className="hidden shrink-0 items-center gap-1 group-hover:flex group-focus-within:flex">
        <Button size="sm" variant="secondary" onClick={() => onOrganize("today")}>
          {t("inbox.action.today")}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onOrganize("tomorrow")}>
          {t("inbox.action.tomorrow")}
        </Button>
        <Menu
          trigger={
            <Button size="sm" variant="ghost" aria-label={t("inbox.action.more")}>
              {t("inbox.action.moreShort")}
            </Button>
          }
          items={moreItems}
        />
      </div>
    </li>
  );
}
