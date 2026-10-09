import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";

/**
 * 悬浮窗的根组件。
 *
 * 目前是一个最小的"徽标"：点击打开主窗口。Today 数字、Hover 展开、拖动与吸附
 * 在实施计划 1.2 ~ 1.8 逐步加入。悬浮窗包体应尽量小，因此这里不引入主窗口专用的 feature
 * （前端规范 §5、§9）。
 *
 * @returns 悬浮窗内容。
 */
export function FloatingApp() {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t("floating.open")}
      onClick={() => void ipc.openMain()}
      className="flex h-full w-full items-center justify-center gap-2 rounded-full border border-border bg-surface text-sm font-medium text-text shadow-md"
    >
      <span aria-hidden="true" className="size-2.5 rounded-full bg-primary" />
      <span>{t("app.name")}</span>
    </button>
  );
}
