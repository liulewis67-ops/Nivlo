import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";

/** 粘贴结果的 Toast 停留多久（毫秒），期间可以撤销。 */
const PASTE_TOAST_MS = 6000;

/**
 * 主窗口里的粘贴捕获：读取剪贴板（只在用户点「粘贴」或按 Ctrl+V 时）并收进 Inbox，
 * 成功后给出可撤销的 Toast（实施计划 2.5）。
 *
 * 剪贴板是空的 / 读取失败时显示对应的错误提示（`CLIPBOARD_EMPTY` / `CLIPBOARD_UNAVAILABLE`）。
 *
 * @returns 触发粘贴的函数。
 */
export function usePasteCapture(
  openItem: ((id: string) => void) | null = null,
): () => Promise<void> {
  const { t } = useTranslation();
  return useCallback(async () => {
    try {
      const result = await ipc.captureFromClipboard();
      const first = result.items[0];
      useToastStore.getState().push(
        "success",
        result.items.length > 1
          ? t("capture.pastedMany", { count: result.items.length })
          : t("capture.pasted", { title: first?.title ?? "" }),
        PASTE_TOAST_MS,
        {
          label: t("capture.undo"),
          undo: true,
          onClick: () => void ipc.undoCapture(result.undoIds).catch(reportError),
        },
        first === undefined || openItem === null
          ? undefined
          : { label: t("capture.view"), onClick: () => openItem(first.id) },
      );
    } catch (error) {
      reportError(error);
    }
  }, [openItem, t]);
}
