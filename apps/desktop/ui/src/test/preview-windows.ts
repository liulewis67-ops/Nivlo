import type { IpcClient } from "@/lib/ipc";
import { AppError } from "@/lib/errors";
import type { MemoryIpc } from "./ipc-mock";

/** 开发预览的同源详情窗口共享内存数据；生产构建不加载此模块。 */
export function previewWindows(memory: MemoryIpc, label: string): IpcClient {
  const opener = window.opener as (Window & { __nivloPreviewIpc?: IpcClient }) | null;
  if (
    label === "detail" &&
    opener?.location.origin === window.location.origin &&
    opener.__nivloPreviewIpc
  )
    return opener.__nivloPreviewIpc;
  const client: IpcClient = {
    ...memory,
    openItemInMain: async (id) => {
      await memory.openItemInMain(id);
      const url = new URL(window.location.href);
      url.search = new URLSearchParams({ window: "detail", item: id }).toString();
      const detail = window.open(url, `detail-${id}`, "width=680,height=800");
      if (detail === null)
        throw new AppError("WINDOW_UNAVAILABLE", "Browser blocked detail window");
      detail.focus();
    },
  };
  Object.assign(window, { __nivloPreviewIpc: client });
  return client;
}
