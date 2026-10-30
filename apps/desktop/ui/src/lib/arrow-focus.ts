import type { KeyboardEvent } from "react";

/**
 * 列表里按 ↑ / ↓ 在同一类控件之间移动焦点（每一行一个，比如勾选框、标题按钮），不用 Tab 穿过行里的其他按钮。
 *
 * 在列表容器的 `onKeyDown` 里调用；只在焦点正落在 `selector` 匹配的元素上时处理，到头就停住。
 *
 * @param event 键盘事件。
 * @param selector 每一行里那个可聚焦元素的选择器。
 * @returns 处理了这次按键时为 `true`。
 */
export function moveFocusWithArrows(event: KeyboardEvent<HTMLElement>, selector: string): boolean {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(selector)) return false;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)];
  const next = items[items.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
  if (next === undefined) return false;
  event.preventDefault();
  next.focus();
  return true;
}
