import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExpandedLayoutDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import { FloatingBadge } from "./FloatingBadge";
import { TodayPanel } from "./TodayPanel";
import { needsPanelWindow } from "./model/floating-machine";
import { useFloatingMachine } from "./use-floating-machine";

/** Today 面板的 logical 宽度（px）。 */
export const PANEL_WIDTH_PX = 300;

/** Today 面板的 logical 高度（px）。 */
export const PANEL_HEIGHT_PX = 380;

/**
 * 悬浮窗根组件：收起时是徽标，Hover 后展开为 Today 面板。
 *
 * 状态由 [`createFloatingMachine`](./model/floating-machine.ts) 驱动：指针进入 / 离开整个窗口
 * 区域（面板与徽标同在一个窗口里，从徽标移向面板的路径始终在窗口内，因此不会"跑出去"
 * 而闪烁）。状态变化后，本组件请求 Rust 调整窗口大小——窗口的位置与尺寸始终由 Rust 控制
 * （前端规范 §9），前端只发出 `expandFloating` / `collapseFloating`。
 *
 * **Hover 期间唯一允许的 IPC 是这两个窗口几何命令**，不查询任何业务数据。
 *
 * @returns 悬浮窗内容。
 */
export function FloatingRoot() {
  const { t } = useTranslation();
  const { state, send } = useFloatingMachine();
  const [layout, setLayout] = useState<ExpandedLayoutDto | null>(null);
  const isPanel = needsPanelWindow(state);
  /** 是否曾经展开过：避免启动时对"本来就是收起"的窗口多发一次收起命令。 */
  const hasExpandedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (isPanel) {
      hasExpandedRef.current = true;
      ipc
        .expandFloating(PANEL_WIDTH_PX, PANEL_HEIGHT_PX)
        .then((result) => {
          if (!cancelled) setLayout(result);
        })
        .catch(reportError);
    } else if (hasExpandedRef.current) {
      setLayout(null);
      ipc.collapseFloating().catch(reportError);
    }
    return () => {
      cancelled = true;
    };
  }, [isPanel]);

  // 后端看门狗发现指针已经离开窗口时补发的事件：弥补 WebView 在指针被快速甩出时漏发 pointerleave。
  useEffect(() => ipc.subscribeFloatingPointerLeft(() => send("pointerLeave")), [send]);

  return (
    <div
      role="group"
      aria-label={t("floating.label")}
      className="h-full w-full"
      onPointerEnter={() => send("pointerEnter")}
      // 指针仍在窗口内移动说明它没有离开；补发 pointerEnter 以取消因漏发 pointerleave 而误启动的收起。
      onPointerMove={() => send("pointerEnter")}
      onPointerLeave={() => send("pointerLeave")}
    >
      {isPanel ? <TodayPanel layout={layout} /> : <FloatingBadge />}
    </div>
  );
}
