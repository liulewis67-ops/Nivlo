import { useEffect } from "react";
import { MainShell } from "@/features/shell";

/**
 * 主窗口的根组件：带导航的外壳（实施计划 1.10）。
 *
 * @returns 主窗口内容。
 */
export function MainApp() {
  useEffect(() => {
    /** 文件和链接放在普通页面上时，避免 WebView 导航离开应用。 */
    function preventDropNavigation(event: DragEvent): void {
      if (event.defaultPrevented || !event.dataTransfer) return;
      const { types } = event.dataTransfer;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const fileInput = target instanceof HTMLInputElement && target.type === "file";
      const editor =
        target?.isContentEditable || target?.matches("input:read-write, textarea:read-write");
      if ((types.includes("Files") && !fileInput) || (!editor && types.includes("text/uri-list"))) {
        event.preventDefault();
      }
    }
    window.addEventListener("drop", preventDropNavigation);
    return () => window.removeEventListener("drop", preventDropNavigation);
  }, []);
  return <MainShell />;
}
