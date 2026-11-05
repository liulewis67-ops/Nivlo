import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MenuModalContext } from "@/components";
import type { ExpandedLayoutDto, ItemTypeDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import { CaptureFeedbackBar, useDropCapture } from "@/features/capture";
import { useInboxCountQuery } from "@/features/inbox";
import { useTodayQuery } from "@/features/today";
import { useAppearanceStore } from "@/stores/appearance-store";
import { useSkinStore } from "@/stores/skin-store";
import { CreateConfiguration } from "@/features/quick-create";
import { FloatingBadge } from "./FloatingBadge";
import { TodayPanel } from "./TodayPanel";
import { DEFAULT_BADGE_SIZE, badgeSize } from "./model/badge-size";
import { needsPanelWindow } from "./model/floating-machine";
import { useFloatingMachine } from "./use-floating-machine";
import { useIgnoreWindowBlur } from "./use-ignore-window-blur";

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
  const today = useTodayQuery();
  // Inbox 数量同理：启动时取一次，之后只由后端事件刷新。
  useInboxCountQuery();
  // 焦点会被马上还给用户之前的应用：菜单不能因此关闭。
  useIgnoreWindowBlur();
  const { state, send } = useFloatingMachine();
  const drop = useDropCapture(send);
  const [layout, setLayout] = useState<ExpandedLayoutDto | null>(null);
  const [quickCreateKind, setQuickCreateKind] = useState<ItemTypeDto | null>(null);
  /** 配置页已打开时托盘 / 快捷键再次请求新增的次数：让配置页重新取回焦点。 */
  const [createFocusRequest, setCreateFocusRequest] = useState(0);
  const isPanel = needsPanelWindow(state);
  const shape = useAppearanceStore((s) => s.appearance.badgeShape);
  const hasSkin = useSkinStore((s) => s.skin.frames.length > 0);
  const { width: badgeWidth, height: badgeHeight } = badgeSize(shape, hasSkin);
  /** 是否曾经展开过：避免启动时对"本来就是收起"的窗口多发一次收起命令。 */
  const hasExpandedRef = useRef(false);
  /** 最近一次告诉后端的徽标尺寸；窗口按默认尺寸创建，形状没变时不必再说一次。 */
  const toldBadgeRef = useRef(DEFAULT_BADGE_SIZE);

  useEffect(() => {
    let cancelled = false;
    if (quickCreateKind !== null) {
      hasExpandedRef.current = true;
      return;
    }
    if (isPanel) {
      hasExpandedRef.current = true;
      ipc
        .expandFloating(PANEL_WIDTH_PX, PANEL_HEIGHT_PX)
        .then((result) => {
          if (!cancelled) setLayout(result);
        })
        .catch(reportError);
    } else if (
      hasExpandedRef.current ||
      badgeWidth !== toldBadgeRef.current.width ||
      badgeHeight !== toldBadgeRef.current.height
    ) {
      // 收起，或者收起态下换了形状 / 皮肤：窗口跟着变成新形状的大小（后端保持贴边位置）。
      hasExpandedRef.current = false;
      toldBadgeRef.current = { width: badgeWidth, height: badgeHeight };
      setLayout(null);
      ipc.collapseFloating(badgeWidth, badgeHeight).catch(reportError);
    }
    return () => {
      cancelled = true;
    };
  }, [isPanel, badgeWidth, badgeHeight, quickCreateKind]);

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

  // 托盘「快速添加」：不管当前是收起还是展开，直接进入待办的配置页；已打开时保留草稿和类型，只取回焦点。
  useEffect(
    () =>
      ipc.subscribeQuickAddRequested(() => {
        setQuickCreateKind((current) => current ?? "todo");
        setCreateFocusRequest((count) => count + 1);
        send("quickCreateRequested");
      }),
    [send],
  );

  // 后端看门狗发现指针已经离开窗口时补发的事件：弥补 WebView 在指针被快速甩出时漏发 pointerleave。
  useEffect(() => ipc.subscribeFloatingPointerLeft(() => send("pointerLeave")), [send]);

  return (
    // 菜单不模态：模态菜单会让页面其余部分不响应指针，面板随之以为指针离开而收起，菜单跟着消失。
    <MenuModalContext.Provider value={false}>
      <div
        role="group"
        aria-label={t("floating.label")}
        className="h-full w-full"
        onPointerEnter={() => send("pointerEnter")}
        // 在徽标上按下左键是要点击或拖动：按住期间不因悬停展开，否则面板会在拖动途中弹出、徽标从手下消失。
        onPointerDown={(event) => {
          if (event.button === 0) send("pressStarted");
        }}
        onPointerUp={() => send("pressEnded")}
        onPointerCancel={() => send("pressEnded")}
        // 指针仍在窗口内移动说明它没有离开；补发 pointerEnter 以取消因漏发 pointerleave 而误启动的收起。
        // 原生窗口拖动结束时页面收不到 pointerup：移动时已经没有按键按着，就当作松开了。
        onPointerMove={(event) => {
          if (event.buttons === 0) send("pressEnded");
          send("pointerEnter");
        }}
        onPointerLeave={() => send("pointerLeave")}
        // WebView 自带的右键菜单（后退 / 刷新 / 检查）在悬浮窗里没有意义；输入框保留，方便复制粘贴。
        onContextMenu={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest("input, textarea, [contenteditable='true']")) event.preventDefault();
        }}
        {...drop.handlers}
      >
        {quickCreateKind !== null ? (
          <CreateConfiguration
            kind={quickCreateKind}
            today={today.data?.date}
            onDone={finishQuickCreate}
            focusRequest={createFocusRequest}
            onPasteNonText={drop.pasteFromClipboard}
            feedback={
              drop.feedback === null ? null : (
                <CaptureFeedbackBar
                  inline
                  feedback={drop.feedback}
                  onUndo={drop.undo}
                  onEdit={() => {
                    drop.dismiss();
                    void ipc.openMain();
                  }}
                  onDismiss={drop.dismiss}
                  onHoldChange={drop.pauseDismiss}
                />
              )
            }
          />
        ) : isPanel ? (
          <TodayPanel
            layout={layout}
            quickCreateKind={null}
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
              // 快速创建输入框里粘贴的不是文字（文件 / 图片）：收进 Inbox 并结束这次快速创建。
              onPaste: () => {
                drop.pasteFromClipboard();
                if (quickCreateKind !== null) finishQuickCreate();
              },
            }}
          />
        ) : (
          <FloatingBadge onQuickAdd={() => startQuickCreate("todo")} />
        )}
      </div>
    </MenuModalContext.Provider>
  );
}
