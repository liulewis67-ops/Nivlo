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
