import { useTranslation } from "react-i18next";

/**
 * 悬浮窗的根组件。
 *
 * 目前只是占位：悬浮窗窗口与 Today 在 Phase 1 实现。悬浮窗包体应尽量小，
 * 因此这里不引入主窗口专用的 feature（前端规范 §5）。
 *
 * @returns 悬浮窗内容。
 */
export function FloatingApp() {
  const { t } = useTranslation();
  return <div className="p-3 text-sm text-muted">{t("floating.placeholder")}</div>;
}
