import type { KeyboardEvent } from "react";

/** 可以用 Tab 走到的元素。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 模态对话框里的 Tab / Shift+Tab 只在对话框内循环，不会走到背后被遮住的页面上。
 *
 * 在对话框根元素的 `onKeyDown` 里调用；不是 Tab 时什么也不做。
 *
 * @param event 键盘事件。
 * @param container 对话框根元素。
 */
export function trapTab(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null): void {
  if (event.key !== "Tab" || container === null) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.closest('[hidden], [inert], [aria-hidden="true"]') === null &&
      getComputedStyle(element).display !== "none" &&
      getComputedStyle(element).visibility !== "hidden",
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    container.focus();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && container.contains(active);
  if (event.shiftKey && (active === first || !inside || active === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !inside || active === container)) {
    event.preventDefault();
    first.focus();
  }
}
