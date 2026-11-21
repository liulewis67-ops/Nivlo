/**
 * 按键是不是落在可输入的地方（输入框、文本区、下拉框、可编辑内容）：这时单个字母或「?」只是在打字，
 * 不应当触发页面快捷键。
 *
 * @param event 键盘事件（React 或原生的都可以）。
 * @returns 正在输入时为 `true`。
 */
export function isTyping(event: { target: EventTarget | null }): boolean {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * 页面上有没有打开的模态对话框（Ctrl+K、快捷键一览、首次引导……）：这时页面快捷键不应当响应。
 *
 * @returns 有时为 `true`。
 */
export function isDialogOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/**
 * 是不是「Ctrl（macOS 上 ⌘）+ 某个键」，且没有按 Alt / Shift。
 *
 * @param event 键盘事件。
 * @param key 字母键（不区分大小写），如 `"n"`。
 * @returns 是时为 `true`。
 */
export function isCommandKey(
  event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  key: string,
): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === key
  );
}
