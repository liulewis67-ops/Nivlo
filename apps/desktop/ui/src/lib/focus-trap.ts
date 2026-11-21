import type { KeyboardEvent } from "react";

/** 可以用 Tab 走到的元素。 */
const FOCUSABLE =
  'a[href], summary, button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 元素本身及祖先必须可见、可交互；几何为零的 jsdom 同样可验证这些规则。 */
function available(element: HTMLElement): boolean {
  if (element.matches(":disabled") || element.closest('[hidden], [inert], [aria-hidden="true"]'))
    return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  const closed = element.closest("details:not([open])");
  if (closed && !closed.querySelector("summary")?.contains(element)) return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const parentStyle = getComputedStyle(parent);
    if (parentStyle.display === "none" || parentStyle.contentVisibility === "hidden") return false;
  }
  return true;
}

/**
 * 关闭模态时恢复可用的来源；来源消失时聚焦页面标题。已有明确的新焦点时不抢回。
 *
 * @param origin 打开前的元素。
 * @param surface 关闭的模态表面。
 */
export function restoreModalFocus(origin: Element | null, surface: HTMLElement | null): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body && !surface?.contains(active)) return;
  if (
    origin instanceof HTMLElement &&
    origin !== document.body &&
    origin.isConnected &&
    available(origin)
  )
    origin.focus();
  else {
    const heading = [...document.querySelectorAll<HTMLElement>("main h1, main h2")].find(available);
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }
}

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
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((element) => element.tabIndex >= 0 && available(element))
    .sort(
      (a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity),
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
