import { useTranslation } from "react-i18next";
import { cx } from "@/lib/cx";
import { useToastStore } from "@/stores/toast-store";
import type { ToastKind } from "@/stores/toast-store";

/** 各类别 Toast 的边框强调色。 */
const KIND_CLASSES: Record<ToastKind, string> = {
  info: "border-l-primary",
  success: "border-l-success",
  error: "border-l-danger",
};

/**
 * Toast 的显示区域，放在应用根部一次。
 *
 * 错误类 Toast 使用 `role="alert"`。普通消息加入持续挂载的播报区，
 * 让读屏软件在提示出现时收到内容变化。
 *
 * @returns Toast 列表；没有 Toast 时渲染空容器。
 */
export function ToastViewport() {
  const { t } = useTranslation();
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-(--nv-z-toast) flex flex-col gap-2">
      <div className="sr-only" aria-live="polite" aria-relevant="additions">
        {toasts
          .filter((toast) => toast.kind !== "error")
          .map((toast) => (
            <div key={toast.id}>{toast.message}</div>
          ))}
      </div>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === "error" ? "alert" : "status"}
          aria-live={toast.kind === "error" ? undefined : "off"}
          className={cx(
            "pointer-events-auto flex max-w-[min(20rem,calc(100vw-1.5rem))] items-start gap-3 rounded-md border border-l-4 border-border",
            "bg-surface px-3 py-2 text-sm text-text shadow-lg",
            KIND_CLASSES[toast.kind],
          )}
        >
          <span className="min-w-0 flex-1 wrap-break-word">{toast.message}</span>
          {[toast.secondaryAction, toast.action].map(
            (action, index) =>
              action !== undefined && (
                <button
                  key={index}
                  type="button"
                  className="shrink-0 font-medium text-primary hover:underline"
                  onClick={() => {
                    action.onClick();
                    if (action === toast.action) dismiss(toast.id);
                  }}
                >
                  {action.label}
                </button>
              ),
          )}
          <button
            type="button"
            aria-label={t("toast.dismiss")}
            className="text-muted hover:text-text"
            onClick={() => dismiss(toast.id)}
          >
            <svg
              viewBox="0 0 16 16"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
