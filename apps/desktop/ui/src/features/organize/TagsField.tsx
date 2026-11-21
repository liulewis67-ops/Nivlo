import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "@/lib/cx";
import type { InboxEntryDto, TagDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useTagsQuery } from "./api";

/** 标签输入框允许的最大长度，与后端一致。 */
const MAX_TAG_CHARS = 50;

/** 最多显示多少条补全建议。 */
const MAX_SUGGESTIONS = 6;

/** [`TagsField`] 的 Props。 */
export type TagsFieldProps = {
  /** 条目 ID。 */
  itemId: string;
  /** 条目当前的标签。 */
  tags: readonly TagDto[];
};

/**
 * 条目的标签编辑：已有标签显示为可移除的小标签，输入框带自动补全。
 *
 * * 回车（或逗号）添加；输入框为空时按 Backspace 移除最后一个；
 * * 补全来自全部已有标签（忽略大小写，已经加上的不再建议），上下键选择、回车确认；
 * * 不存在的标签会自动创建，忽略大小写重复的标签由后端合并；
 * * 每次修改立即保存（标签是离散操作，不需要防抖），失败时提示且界面保持原状。
 *
 * @param props 条目 ID 与当前标签。
 * @returns 标签编辑区。
 */
export function TagsField({ itemId, tags }: TagsFieldProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const all = useTagsQuery().data ?? [];
  const [text, setText] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const listId = useId();

  const taken = new Set(tags.map((tag) => tag.name.toLowerCase()));
  const needle = text.trim().toLowerCase();
  const suggestions =
    needle === ""
      ? []
      : all
          .map((summary) => summary.tag)
          .filter((tag) => !taken.has(tag.name.toLowerCase()))
          .filter((tag) => tag.name.toLowerCase().includes(needle))
          .slice(0, MAX_SUGGESTIONS);

  /**
   * 把条目的标签整体换成 `names`，成功后更新详情缓存并让相关列表失效。
   *
   * @param names 新的标签名列表。
   */
  async function commit(names: string[]): Promise<void> {
    try {
      const saved = await ipc.setItemTags(itemId, names);
      queryClient.setQueryData<InboxEntryDto>(queryKeys.itemDetail(itemId), (old) =>
        old === undefined ? old : { ...old, tags: saved },
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.tags() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.items() });
    } catch (error) {
      reportError(error);
    }
  }

  /**
   * 添加一个标签（已经有同名标签时什么都不做）。
   *
   * @param raw 用户输入或选中的建议。
   */
  function add(raw: string): void {
    const name = raw.trim();
    setText("");
    setHighlight(-1);
    if (name === "" || taken.has(name.toLowerCase())) return;
    void commit([...tags.map((tag) => tag.name), name]);
  }

  /**
   * 键盘：回车 / 逗号添加，上下键选建议，空输入框里 Backspace 移除最后一个。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      const chosen = highlight >= 0 ? suggestions[highlight]?.name : undefined;
      add(chosen ?? text);
    } else if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((highlight + 1) % suggestions.length);
    } else if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((highlight - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Escape" && text !== "") {
      // 先清掉输入，不要连带关闭详情面板。
      event.stopPropagation();
      setText("");
      setHighlight(-1);
    } else if (event.key === "Backspace" && text === "" && tags.length > 0) {
      void commit(tags.slice(0, -1).map((tag) => tag.name));
    }
  }

  return (
    <div className="relative flex flex-col gap-2">
      {tags.length > 0 && (
        <ul aria-label={t("detail.field.tags")} className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li
              key={tag.id}
              className="flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs text-text"
            >
              <span>{tag.name}</span>
              <button
                type="button"
                aria-label={t("detail.tags.remove", { name: tag.name })}
                onClick={() =>
                  void commit(
                    tags.filter((other) => other.id !== tag.id).map((other) => other.name),
                  )
                }
                className="flex size-4 items-center justify-center rounded-full text-muted hover:bg-primary/20 hover:text-text"
              >
                {"✕"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
        aria-label={t("detail.tags.addLabel")}
        placeholder={t("detail.tags.add")}
        maxLength={MAX_TAG_CHARS}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setHighlight(-1);
        }}
        onKeyDown={handleKeyDown}
        className={cx(
          "h-9 w-full rounded-md border border-border bg-bg px-3 text-sm text-text",
          "placeholder:text-muted focus-visible:border-primary focus-visible:outline-none",
        )}
      />
      {suggestions.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("detail.tags.suggestions")}
          className="absolute top-full z-(--nv-z-menu) mt-1 w-full overflow-hidden rounded-md border border-border bg-surface p-1 shadow-md"
        >
          {suggestions.map((tag, index) => (
            <li
              key={tag.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlight}
              // mousedown 而不是 click：输入框失焦之前就要选中，否则建议先消失了。
              onMouseDown={(event) => {
                event.preventDefault();
                add(tag.name);
              }}
              className={cx(
                "cursor-pointer rounded-sm px-2 py-1.5 text-sm text-text",
                index === highlight ? "bg-surface-hover" : "hover:bg-surface-hover",
              )}
            >
              {tag.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
