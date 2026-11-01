import { useEffect, useState } from "react";
import type { RefObject } from "react";

/** 按实际容器的逻辑宽度选择布局；与 UI/UX 实施指南保持一致。 */
export const LAYOUT = {
  compactShell: 800,
  dockedDetail: 1200,
  dockedBacklog: 1000,
  stackedCalendarWeek: 600,
  stackedWorkspace: 700,
} as const;

/**
 * 监听容器宽度；首帧使用窗口逻辑宽度，测试环境可用 resize 回退。
 *
 * @param ref 稳定的外壳容器。
 * @returns CSS 像素宽度，与物理 DPI 无关。
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    /** 更新逻辑宽度，不在 React 内计算原生窗口尺寸。 */
    const measure = (): void =>
      setWidth(element.getBoundingClientRect().width || window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return width;
}
