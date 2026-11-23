import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { coalesce } from "@/lib/coalesce";
import { isRunningInTauri } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import appIcon from "../../../../src-tauri/icons/32x32.png";

const CONTROL_CLASS =
  "grid h-full w-11 place-items-center text-muted transition-colors focus-visible:outline-offset-[-3px]";
const STANDARD_CONTROL = `${CONTROL_CLASS} hover:bg-surface-hover hover:text-text`;

/** 自绘窗口标题栏；详情可提供事项名及保存后关闭的回调。 */
export function WindowTitlebar({ title, onClose }: { title?: string; onClose?: () => void } = {}) {
  const { t } = useTranslation();
  const native = isRunningInTauri();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!native) return;
    const window = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // 拖动边缘时合并连续的尺寸事件；也同步系统快捷键和双击带来的状态变化。
    const update = coalesce(() => {
      window
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(reportError);
    }, 100);
    window
      .onResized(update.signal)
      .then((stop) => {
        if (disposed) stop();
        else {
          unlisten = stop;
          update.signal();
        }
      })
      .catch(reportError);
    return () => {
      disposed = true;
      unlisten?.();
      update.cancel();
    };
  }, [native]);

  const maximizeLabel = t(maximized ? "shell.window.restore" : "shell.window.maximize");
  return (
    <div className="flex h-10 shrink-0 select-none items-stretch border-b-[0.5px] border-border bg-surface">
      <div data-tauri-drag-region="deep" className="flex min-w-0 flex-1 items-center gap-2.5 px-4">
        <span
          aria-hidden="true"
          className="size-5 shrink-0 bg-contain bg-center bg-no-repeat"
          style={{ backgroundImage: `url(${appIcon})` }}
        />
        <span className="truncate text-sm font-semibold text-text">{title ?? t("app.name")}</span>
      </div>
      <div className="flex shrink-0 items-stretch">
        <button
          type="button"
          aria-label={t("shell.window.minimize")}
          title={t("shell.window.minimize")}
          className={STANDARD_CONTROL}
          disabled={!native}
          onClick={() => getCurrentWindow().minimize().catch(reportError)}
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            <path d="M3.5 8h9" stroke="currentColor" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={maximizeLabel}
          title={maximizeLabel}
          className={STANDARD_CONTROL}
          disabled={!native}
          onClick={() => getCurrentWindow().toggleMaximize().catch(reportError)}
        >
          <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden="true">
            {maximized ? (
              <path d="M6.5 5.5v-2h6v6h-2m-7-4h7v7h-7z" stroke="currentColor" />
            ) : (
              <rect x="3.5" y="3.5" width="9" height="9" rx=".5" stroke="currentColor" />
            )}
          </svg>
        </button>
        <button
          type="button"
          aria-label={t("shell.window.close")}
          title={t("shell.window.close")}
          className={`${CONTROL_CLASS} hover:bg-danger hover:text-danger-contrast`}
          disabled={!native}
          onClick={() => {
            if (onClose) onClose();
            else void getCurrentWindow().close().catch(reportError);
          }}
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
