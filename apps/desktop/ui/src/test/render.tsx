import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { AppProviders, createQueryClient } from "@/app/providers/AppProviders";
import { setIpcClient } from "@/lib/ipc";
import type { IpcClient } from "@/lib/ipc";
import { createMemoryIpc } from "./ipc-mock";

/**
 * 在完整的应用 Provider 中渲染组件，并使用给定（或新建的）内存 IPC。
 *
 * @param ui 待渲染的元素。
 * @param ipc 要使用的 IPC 实现；缺省为全新的内存实现。
 * @returns Testing Library 的渲染结果。
 */
export function renderWithProviders(ui: ReactElement, ipc: IpcClient = createMemoryIpc()) {
  setIpcClient(ipc);
  return render(<AppProviders queryClient={createQueryClient()}>{ui}</AppProviders>);
}
