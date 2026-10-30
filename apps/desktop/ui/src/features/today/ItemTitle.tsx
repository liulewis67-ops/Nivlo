import type { MouseEvent } from "react";
import { useOpenItem } from "@/features/detail";

/** [`ItemTitle`] 的 Props。 */
export type ItemTitleProps = {
  /** Item ID。 */
  id: string;
  /** 标题。 */
  title: string;
  /** 简述：接在标题后面、颜色更淡；与标题共用一行，放不下时先截掉它。 */
  brief?: string | null;
};

/**
 * 列表行里的标题：当前窗口有详情面板（主窗口）时是可点击的按钮，点击打开详情；
 * 悬浮窗没有详情面板，保持纯文字。
 *
 * 标题放不下时以省略号结尾；指针移上去时显示完整标题（只在确实被截断时，短标题不出多余的提示）。
 * 悬浮窗只有 300px 宽，长标题很常见，又没有详情面板可看。
 *
 * 有简述时接在标题后面（同一行、更淡），提示里标题与简述各占一行。
 *
 * @param props 条目 ID、标题与简述。
 * @returns 标题元素。
 */
export function ItemTitle({ id, title, brief }: ItemTitleProps) {
  const openItem = useOpenItem();
  const full = brief ? `${title}\n${brief}` : title;
  const text = (
    <>
      {title}
      {brief && <span className="ml-2 text-xs text-muted">{brief}</span>}
    </>
  );
  /**
   * 指针移入时按是否被截断设置原生提示。
   *
   * @param event 鼠标事件。
   */
  const showFullTitleIfTruncated = (event: MouseEvent<HTMLElement>) => {
    const element = event.currentTarget;
    element.title = element.scrollWidth > element.clientWidth ? full : "";
  };
  if (openItem === null) {
    return (
      <span className="flex-1 truncate" onMouseEnter={showFullTitleIfTruncated}>
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openItem(id)}
      onMouseEnter={showFullTitleIfTruncated}
      className="flex-1 truncate text-left hover:underline"
    >
      {text}
    </button>
  );
}
