import type { ReactElement } from "react";
import type { MainView } from "./nav-store";

/** 各视图的图标路径（16×16 画布、描边风格），保持整体线性图标风格一致。 */
const ICON_PATHS: Record<MainView, ReactElement> = {
  inbox: (
    <path d="M2.5 9.5l1.6-5.2a1 1 0 0 1 1-.8h5.8a1 1 0 0 1 1 .8l1.6 5.2v2.7a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V9.5zm0 0h3.2l.8 1.5h3l.8-1.5h3.2" />
  ),
  today: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8.2l1.8 1.8 3.4-3.8" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </>
  ),
  notes: (
    <>
      <path d="M4 2.5h6l2.5 2.5v8a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5z" />
      <path d="M5.8 7.5h4.4M5.8 10h4.4" />
    </>
  ),
  projects: (
    <path d="M2.5 4.5a1 1 0 0 1 1-1h2.8l1.4 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7.5z" />
  ),
  trash: (
    <>
      <path d="M3 4.5h10M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5" />
      <path d="M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8M6.8 7v4M9.2 7v4" />
    </>
  ),
  dev: <path d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M9 3.5l-2 9" />,
};

/** [`NavIcon`] 的 Props。 */
type NavIconProps = {
  /** 图标对应的视图。 */
  view: MainView;
};

/**
 * 侧栏导航图标：装饰性，名称由旁边的文字提供，所以对读屏隐藏。
 *
 * @param props 视图。
 * @returns SVG 图标。
 */
export function NavIcon({ view }: NavIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[view]}
    </svg>
  );
}
