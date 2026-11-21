/**
 * 是不是会触发 WebView2 浏览器功能的「顺手按键」：刷新（F5、Ctrl+R、Ctrl+Shift+R、Ctrl+F5）、
 * 打印（Ctrl+P）、另存网页（Ctrl+S）、查看源代码（Ctrl+U）。
 *
 * 在桌面应用里这些都没有意义，刷新还会丢掉没保存的输入、关掉打开的面板。缩放（Ctrl + / -）与
 * 页内查找（Ctrl+F）不在其中：有人靠它们放大文字、找内容。
 *
 * @param event 键盘事件。
 * @returns 应当拦下时为 `true`。
 */
export function isBrowserReflexKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  if (event.altKey) return false;
  if (event.key === "F5") return true;
  if (!(event.ctrlKey || event.metaKey)) return false;
  return ["r", "p", "s", "u"].includes(event.key.toLowerCase());
}

/**
 * 在窗口上拦下 [`isBrowserReflexKey`] 认出的按键，阻止 WebView2 执行对应的浏览器功能。
 *
 * 只调用 `preventDefault`，事件照常传给页面里的其他监听者。
 *
 * @param target 要安装的窗口。
 * @returns 卸载函数。
 */
export function blockBrowserReflexKeys(target: Window): () => void {
  /**
   * 拦下浏览器功能键。
   *
   * @param event 键盘事件。
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isBrowserReflexKey(event)) event.preventDefault();
  };
  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", onKeyDown, { capture: true });
}
