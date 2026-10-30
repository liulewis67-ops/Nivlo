import type { ClipboardEvent, KeyboardEvent } from "react";
import {
  continueMarkdownList,
  indentMarkdownList,
  linkOnPaste,
  toggleMarkdownTask,
  toggleMarkdownWrap,
} from "./markdown-wrap";
import type { WrapResult } from "./markdown-wrap";
import { isCommandKey } from "./typing";

/**
 * Markdown 正文文本框的按键（笔记编辑区与详情面板的描述共用）：
 *
 * * Ctrl+B 加粗、Ctrl+I 斜体，再按一次取消；
 * * 在列表项末尾按 Enter 续上记号，空的一项按 Enter 结束列表（输入法组字时的 Enter 不处理）；
 * * 列表项上 Tab / Shift+Tab 缩进 / 取消缩进；不在列表里时照常移走焦点；
 * * 任务项上 Ctrl+Enter 勾选 / 取消勾选。
 *
 * 调用方只在内容格式是 Markdown 时调用。
 *
 * @param event 键盘事件。
 * @param setContent 浏览器不支持「插入文字」时直接改内容的回调。
 * @returns 处理了这次按键时为 `true`。
 */
export function handleMarkdownKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  setContent: (content: string) => void,
): boolean {
  const area = event.currentTarget;
  const { selectionStart: start, selectionEnd: end, value } = area;
  const marker = isCommandKey(event, "b") ? "**" : isCommandKey(event, "i") ? "*" : null;
  const unmodified = !event.ctrlKey && !event.metaKey && !event.altKey;
  const plainEnter =
    event.key === "Enter" && !event.nativeEvent.isComposing && !event.shiftKey && unmodified;
  const tab = event.key === "Tab" && unmodified;
  const next =
    marker !== null
      ? toggleMarkdownWrap(value, start, end, marker)
      : isCommandKey(event, "enter")
        ? toggleMarkdownTask(value, start, end)
        : plainEnter
          ? continueMarkdownList(value, start, end)
          : tab
            ? indentMarkdownList(value, start, end, event.shiftKey)
            : null;
  if (next === null) return false;
  event.preventDefault();
  applyEdit(area, next, setContent);
  return true;
}

/**
 * Markdown 正文里粘贴：选中文字后粘贴一个网址，变成 `[文字](网址)`；其余情况按普通粘贴。
 *
 * @param event 粘贴事件。
 * @param setContent 浏览器不支持「插入文字」时直接改内容的回调。
 * @returns 处理了这次粘贴时为 `true`。
 */
export function handleMarkdownPaste(
  event: ClipboardEvent<HTMLTextAreaElement>,
  setContent: (content: string) => void,
): boolean {
  const area = event.currentTarget;
  const next = linkOnPaste(
    area.value,
    area.selectionStart,
    area.selectionEnd,
    event.clipboardData.getData("text/plain"),
  );
  if (next === null) return false;
  event.preventDefault();
  applyEdit(area, next, setContent);
  return true;
}

/**
 * 把文本框改成 `next`：尽量用浏览器的「插入文字」只替换变化的那一段，这样 Ctrl+Z 还能撤销；
 * 不支持时调用 `setContent` 直接改内容。
 *
 * @param area 文本框。
 * @param next 新的全文与选区。
 * @param setContent 直接改内容的回调。
 */
function applyEdit(
  area: HTMLTextAreaElement,
  next: WrapResult,
  setContent: (content: string) => void,
): void {
  const before = area.value;
  let from = 0;
  while (from < before.length && from < next.value.length && before[from] === next.value[from]) {
    from += 1;
  }
  let tail = 0;
  while (
    tail < before.length - from &&
    tail < next.value.length - from &&
    before[before.length - 1 - tail] === next.value[next.value.length - 1 - tail]
  ) {
    tail += 1;
  }
  area.setSelectionRange(from, before.length - tail);
  const viaBrowser =
    typeof document.execCommand === "function" &&
    document.execCommand("insertText", false, next.value.slice(from, next.value.length - tail));
  if (viaBrowser) {
    area.setSelectionRange(next.start, next.end);
    return;
  }
  setContent(next.value);
  requestAnimationFrame(() => area.setSelectionRange(next.start, next.end));
}
