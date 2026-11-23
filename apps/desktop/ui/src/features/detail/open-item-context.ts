import { createContext, useContext } from "react";

/**
 * 「打开这个条目的详情」的能力。
 *
 * 主窗口在内容区展示详情；悬浮窗与全局搜索通过 IPC 打开独立详情窗口。
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
