import { useTranslation } from "react-i18next";
import type { MainView } from "./nav-store";

/** [`ComingSoon`] 的 Props。 */
export type ComingSoonProps = {
  /** 尚未实现的视图。 */
  view: Exclude<MainView, "inbox" | "today" | "notes" | "projects" | "trash" | "settings" | "dev">;
};

/**
 * 尚未实现的视图的占位页：告诉用户这里将来放什么，而不是一块空白。
 *
 * @param props 视图。
 * @returns 占位内容。
 */
export function ComingSoon({ view }: ComingSoonProps) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t(`shell.nav.${view}`)}
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <h1 className="text-xl font-semibold text-text">{t(`shell.nav.${view}`)}</h1>
      <p className="max-w-sm text-sm text-muted">{t(`shell.comingSoon.${view}`)}</p>
    </section>
  );
}
