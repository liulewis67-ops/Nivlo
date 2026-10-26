import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { SearchPanel } from "./SearchPanel";

/**
 * 全局搜索窗口的根组件：在任何应用之上按全局快捷键弹出（默认 Ctrl+Alt+Space）。
 *
 * * 窗口由后端显示 / 隐藏；每次显示（`search_window_shown`）都重新挂载面板——清空上次的输入、
 *   重新聚焦输入框，并丢掉旧的搜索缓存，保证结果是最新的；
 * * 页面失去焦点时（后端随即隐藏窗口）也先重置，下次出现时不会闪一下上次的结果；
 * * 回车 / 点击：交给主窗口打开详情（后端同时隐藏搜索框）；Esc：隐藏并把焦点还给之前的应用。
 *
 * @returns 填满窗口的搜索面板。
 */
export function SearchApp() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [session, setSession] = useState(0);

  const reset = useCallback(() => {
    queryClient.removeQueries({ queryKey: queryKeys.searchAll() });
    setSession((current) => current + 1);
  }, [queryClient]);

  useEffect(() => ipc.subscribeSearchWindowShown(reset), [reset]);
  useEffect(() => {
    window.addEventListener("blur", reset);
    return () => window.removeEventListener("blur", reset);
  }, [reset]);

  return (
    <div className="h-screen">
      <SearchPanel
        key={session}
        variant="window"
        emptyHint={t("search.windowHint")}
        onClose={() => void ipc.hideSearch()}
        onOpenItem={(id) => {
          ipc.openItemInMain(id).catch(reportError);
        }}
      />
    </div>
  );
}
