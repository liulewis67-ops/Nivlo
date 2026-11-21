import type { ReactElement } from "react";
import type { EntryKind } from "./model/inbox-entry";

/** 各来源类别的图标路径（16×16 画布、描边风格，与导航图标一致）。 */
const ICON_PATHS: Record<EntryKind, ReactElement> = {
  url: (
    <>
      <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6" />
      <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6" />
    </>
  ),
  file: (
    <>
      <path d="M4 2.5h5l3 3v8a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5z" />
      <path d="M9 2.5v3h3" />
    </>
  ),
  text: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
  image: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1" />
      <path d="M3 12l3.5-3.2 2.5 2.2 2-1.8 2.5 2.3" />
    </>
  ),
  other: <circle cx="8" cy="8" r="4.5" />,
};

/** [`SourceIcon`] 的 Props。 */
export type SourceIconProps = {
  /** 来源类别。 */
  kind: EntryKind;
};

/**
 * 来源图标：装饰性，类别名由旁边的文字提供，所以对读屏隐藏。
 *
 * @param props 来源类别。
 * @returns SVG 图标。
 */
export function SourceIcon({ kind }: SourceIconProps) {
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
      {ICON_PATHS[kind]}
    </svg>
  );
}
