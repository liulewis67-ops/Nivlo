import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { ItemDetailPanel } from "@/features/detail";
import { Button } from "@/components";
import { ipc, isRunningInTauri } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useDraftTransitionStore } from "@/stores/draft-transition-store";
import { WindowTitlebar } from "@/app/main/WindowTitlebar";

/** 真正销毁已完成保存的独立窗口；浏览器预览关闭对应的标签页。 */
function closeWindow(): void {
  if (isRunningInTauri()) void getCurrentWindow().destroy().catch(reportError);
  else window.close();
}

/** 独立详情根：一个窗口仅承载一个事项，原生关闭与页内关闭共用草稿保护。 */
export function DetailApp({
  id = new URLSearchParams(window.location.search).get("item") ?? "",
}: {
  id?: string;
}) {
  const { t } = useTranslation();
  const [deleted, setDeleted] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.itemDetail(id),
    queryFn: () => ipc.getItemDetail(id),
  });
  const item = query.data?.item;
  const title = `${item?.title ?? t("detail.title")} · AsterJot`;
  useEffect(() => {
    document.title = title;
    if (isRunningInTauri()) void getCurrentWindow().setTitle(title).catch(reportError);
  }, [title]);
  useEffect(() => {
    if (!isRunningInTauri()) return;
    const nativeWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void nativeWindow
      .onCloseRequested((event) => {
        event.preventDefault();
        useDraftTransitionStore.getState().request(closeWindow);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(reportError);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <WindowTitlebar
        title={title}
        onClose={() => useDraftTransitionStore.getState().request(closeWindow)}
      />
      <main className="min-h-0 w-full flex-1 overflow-hidden bg-surface">
        {deleted ? (
          <section
            aria-label={t("detail.label")}
            className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
          >
            <p className="text-sm">{t("trash.deleted", { title: item?.title ?? "" })}</p>
            <div className="flex gap-2">
              <Button
                onClick={() =>
                  void ipc
                    .restoreDeletedItems([id])
                    .then(async () => {
                      await query.refetch();
                      setDeleted(false);
                    })
                    .catch(reportError)
                }
              >
                {t("today.undo")}
              </Button>
              <Button onClick={closeWindow}>{t("detail.close")}</Button>
            </div>
          </section>
        ) : (
          <ItemDetailPanel
            key={id}
            id={id}
            standalone
            onClose={closeWindow}
            onDeleted={() => setDeleted(true)}
          />
        )}
      </main>
    </div>
  );
}
