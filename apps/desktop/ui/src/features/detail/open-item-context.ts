import { createContext, useContext } from "react";

/**
 * 「打开这个条目的详情」的能力。
 *
 * 主窗口打开自己的详情面板；悬浮窗通过 IPC 在主窗口打开对应事项。
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
