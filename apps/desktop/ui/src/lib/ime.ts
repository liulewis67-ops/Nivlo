/**
 * 辨认输入法仍在处理的按键，包括组合标志提前清除时的 Process 键。
 * @param event 原生键盘事件。
 * @returns 该按键应由输入法处理。
 */
export function isImeKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
