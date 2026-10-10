import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExpandedLayoutDto, ItemTypeDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import { useDropCapture } from "@/features/capture";
import { useInboxCountQuery } from "@/features/inbox";
import { useTodayQuery } from "@/features/today";
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
  // 悬浮窗启动时取一次 Today 并保持缓存（staleTime 为无穷）；之后只由后端事件刷新。
  // 放在根组件而不是面板里：面板在 Hover 时才挂载，必须直接读缓存而不是在 Hover 时取数。
  useTodayQuery();
  // Inbox 数量同理：启动时取一次，之后只由后端事件刷新。
  useInboxCountQuery();
  const { state, send } = useFloatingMachine();
  const drop = useDropCapture(send);
  const [layout, setLayout] = useState<ExpandedLayoutDto | null>(null);
  const [quickCreateKind, setQuickCreateKind] = useState<ItemTypeDto | null>(null);
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

  /**
   * 进入快速创建：状态机切到 QuickCreate（此时指针离开不会收起面板），并显示输入行。
   *
   * @param kind 要创建的类型。
   */
  function startQuickCreate(kind: ItemTypeDto): void {
    setQuickCreateKind(kind);
    send("quickCreateRequested");
  }

  /** 快速创建结束：回到展开态；指针已离开时状态机会延迟收起，而不是瞬间消失。 */
  function finishQuickCreate(): void {
    setQuickCreateKind(null);
    send("quickCreateFinished");
  }

  // 托盘「快速添加」：不管当前是收起还是展开，直接进入待办的快速创建。
  useEffect(
    () =>
      ipc.subscribeQuickAddRequested(() => {
        setQuickCreateKind("todo");
        send("quickCreateRequested");
      }),
    [send],
  );

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
      {...drop.handlers}
    >
      {isPanel ? (
        <TodayPanel
          layout={layout}
          quickCreateKind={quickCreateKind}
          onQuickCreate={startQuickCreate}
          onQuickCreateKindChange={setQuickCreateKind}
          onQuickCreateDone={finishQuickCreate}
          dropActive={drop.hovering}
          capture={{
            feedback: drop.feedback,
            onUndo: drop.undo,
            onEdit: () => {
              drop.dismiss();
              void ipc.openMain();
            },
            onDismiss: drop.dismiss,
            onHoldChange: drop.pauseDismiss,
          }}
        />
      ) : (
        <FloatingBadge />
      )}
    </div>
  );
}
