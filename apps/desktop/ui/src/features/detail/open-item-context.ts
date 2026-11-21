import { createContext, useContext } from "react";

/**
 * 「打开这个条目的详情」的能力。
 *
 * 只有主窗口提供它（它有详情面板）；悬浮窗没有，所以共用的列表组件在悬浮窗里不会把标题变成可点击的按钮。
 */
export const OpenItemContext = createContext<((id: string) => void) | null>(null);

/**
 * 取得「打开条目详情」的函数；当前窗口没有详情面板时为 `null`。
 *
 * @returns 打开函数或 `null`。
 */
export function useOpenItem(): ((id: string) => void) | null {
  return useContext(OpenItemContext);
}
