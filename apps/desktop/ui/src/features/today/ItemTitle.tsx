import { useOpenItem } from "@/features/detail";

/** [`ItemTitle`] 的 Props。 */
export type ItemTitleProps = {
  /** Item ID。 */
  id: string;
  /** 标题。 */
  title: string;
};

/**
 * 列表行里的标题：当前窗口有详情面板（主窗口）时是可点击的按钮，点击打开详情；
 * 悬浮窗没有详情面板，保持纯文字。
 *
 * @param props 条目 ID 与标题。
 * @returns 标题元素。
 */
export function ItemTitle({ id, title }: ItemTitleProps) {
  const openItem = useOpenItem();
  if (openItem === null) return <span className="flex-1 truncate">{title}</span>;
  return (
    <button
      type="button"
      onClick={() => openItem(id)}
      className="flex-1 truncate text-left hover:underline"
    >
      {title}
    </button>
  );
}
