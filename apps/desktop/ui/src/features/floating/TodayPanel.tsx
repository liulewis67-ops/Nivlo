import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import type { ExpandedLayoutDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";

/** [`TodayPanel`] 的 Props。 */
export type TodayPanelProps = {
  /** 展开方向：面板从徽标所在的角"长出来"，据此设置动画的 transform-origin；展开完成前为 `null`。 */
  layout: ExpandedLayoutDto | null;
};

/**
 * 悬浮窗展开后的 Today 面板。
 *
 * 目前是面板外壳：标题、空状态与"打开主窗口"。Today 列表在实施计划 1.4 接入——
 * 到那时 Hover 展开只使用已缓存的 Today 数据渲染，不触发任何业务数据的 IPC。
 *
 * @param props 展开方向。
 * @returns 面板元素。
 */
export function TodayPanel({ layout }: TodayPanelProps) {
  const { t } = useTranslation();
  const origin = layout === null ? "top right" : `${layout.vertical} ${layout.horizontal}`;
  return (
    <section
      aria-label={t("today.panel.label")}
      style={{ transformOrigin: origin }}
      className="nv-panel-in flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold text-text">
          {t("today.panel.title")}
          <span className="ml-2 font-normal text-muted">
            {format(new Date(), "M月d日 EEEE", { locale: zhCN })}
          </span>
        </h2>
        <Button size="sm" variant="ghost" onClick={() => void ipc.openMain()}>
          {t("today.panel.openMain")}
        </Button>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-center">
        <p className="text-sm font-medium text-text">{t("today.empty.title")}</p>
        <p className="text-xs text-muted">{t("today.empty.hint")}</p>
      </div>
    </section>
  );
}
