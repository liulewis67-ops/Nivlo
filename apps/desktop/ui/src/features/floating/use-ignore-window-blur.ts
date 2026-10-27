import { useEffect } from "react";

/**
 * 悬浮窗里有菜单开着时，拦下窗口级的 `blur` 事件，让菜单在焦点被还回去之后仍然开着。
 *
 * 悬浮窗不抢焦点：点一下之后（WebView2 会把它激活），后端随即把前台还给用户之前的应用
 * （`FloatingHandle::on_focused`）。Radix 的菜单（「更多操作」与右键菜单）在 `window` 失去焦点时
 * 会自动关闭，于是刚点开的菜单马上消失、无法选择。这里只在有菜单开着时、在捕获阶段（先于 Radix
 * 的监听）停止它的传播；点面板别处、面板收起时菜单照常关闭。没有菜单时窗口 `blur` 照常传递——
 * Quick Create 靠它在用户点别处时取消输入。
 */
export function useIgnoreWindowBlur(): void {
  useEffect(() => {
    /**
     * 有菜单开着时拦下窗口自己的 `blur`。
     *
     * @param event 焦点事件。
     */
    const stop = (event: FocusEvent) => {
      if (event.target === window && document.querySelector("[role=menu]") !== null) {
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("blur", stop, { capture: true });
    return () => window.removeEventListener("blur", stop, { capture: true });
  }, []);
}
