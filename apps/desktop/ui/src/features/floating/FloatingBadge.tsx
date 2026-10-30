import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useTodayQuery } from "@/features/today";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import { useAppearanceStore } from "@/stores/appearance-store";
import { useSkinStore } from "@/stores/skin-store";
import { createDragIntentTracker } from "./model/drag-intent";
import { SkinSprite } from "./SkinSprite";

/** 待办数尚未加载完成时徽标上显示的占位符。 */
const PLACEHOLDER = "–";

/** [`FloatingBadge`] 的 Props。 */
type FloatingBadgeProps = {
  /** 右键徽标：直接进入待办的快速创建。 */
  onQuickAdd?: () => void;
};

/**
 * 今天的完成进度环：轨道是浅色整圈，主色弧线表示已完成的比例，从 12 点钟方向顺时针增长。
 *
 * @param props `progress` 为 0~1；`size` 为外径（px）；`stroke` 为线宽（px）。
 * @returns 装饰性的 SVG。
 */
function ProgressRing({
  progress,
  size,
  stroke,
  className,
}: {
  progress: number;
  size: number;
  stroke: number;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cx("nv-badge-ring shrink-0 -rotate-90", className)}
    >
      <circle
        className="nv-badge-ring-track"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
      />
      <circle
        className="nv-badge-ring-value"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        pathLength={100}
        strokeDasharray="100"
        // 一点都没完成时把弧线完全藏起来，否则圆头线帽会留下一个小点。
        strokeDashoffset={100 - progress * 100}
        opacity={progress > 0 ? 1 : 0}
      />
      {/* 小徽标中心的主色圆点：还没开始完成时也有一点颜色，不会被读成字母 O。 */}
      {size < 24 && (
        <circle className="nv-badge-ring-core" cx={size / 2} cy={size / 2} r={size / 7} />
      )}
    </svg>
  );
}

/** 「今天都做完了」的对勾。 */
function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={cx("nv-badge-check", className)}>
      <path d="M4 8.4 6.8 11 12 5.2" />
    </svg>
  );
}

/**
 * 悬浮窗收起态的徽标：今天还剩多少件事，外加一个完成进度环（产品文档 §5.1）。
 *
 * 形状决定内容：胶囊 = 进度环 + 数字；数字 = 圆形徽标，边缘就是进度环，数字居中；圆点 = 只有进度环。
 * 今天的事全部完成时数字换成对勾。窗口和形状一样大（尺寸见 [`badgeSize`](./model/badge-size.ts)）。
 *
 * 同一个元素承担几种交互：单击打开主窗口；按住并移动超过阈值则请求后端开始拖动窗口；
 * 右键直接进入快速添加。拖动结束后的吸附与位置保存都在 Rust 一侧完成，这里只负责识别手势意图。
 *
 * 开始拖动后系统会接管鼠标，通常不会再收到 `click`；若仍收到，用 `draggedRef` 吞掉这一次，
 * 避免"拖完松手却打开了主窗口"。键盘激活（Enter / 空格）产生的 `click` 不受影响。
 *
 * 数字来自 Today 的查询缓存，由后端事件刷新；渲染徽标不会发起任何 IPC。
 *
 * @param props 右键快速添加的回调。
 * @returns 徽标按钮。
 */
export function FloatingBadge({ onQuickAdd }: FloatingBadgeProps = {}) {
  const { t } = useTranslation();
  const today = useTodayQuery();
  /** 今天还剩的事；尚未加载完成时为 `null`，显示占位而不是误导性的 0。 */
  const remaining = today.data?.remainingCount ?? null;
  const done = today.data?.completed.length ?? 0;
  const total = (remaining ?? 0) + done;
  const progress = total > 0 ? done / total : 0;
  const allDone = remaining === 0 && done > 0;
  const shape = useAppearanceStore((state) => state.appearance.badgeShape);
  const skin = useSkinStore((state) => state.skin);
  const [hovered, setHovered] = useState(false);
  const hasSkin = skin.frames.length > 0;
  const trackerRef = useRef(createDragIntentTracker());
  const draggedRef = useRef(false);
  /** 按下的位置（窗口内坐标）：开始拖动时交给后端，让徽标保持在光标下。 */
  const grabRef = useRef<{ x: number; y: number } | null>(null);
  /** 数字是否变过：第一次显示时不跳动，之后每次变化轻轻弹一下，让用户注意到"少了一件"。 */
  const previousRef = useRef(remaining);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (previousRef.current !== null && previousRef.current !== remaining) setChanged(true);
    previousRef.current = remaining;
  }, [remaining]);

  /**
   * 记录按下位置，开始一次新手势。
   *
   * @param event 指针事件；只响应主键（左键）。
   */
  function handlePointerDown(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    draggedRef.current = false;
    grabRef.current = { x: event.clientX, y: event.clientY };
    trackerRef.current.press({ x: event.clientX, y: event.clientY });
  }

  /**
   * 指针移动：跨过阈值的那一刻请求后端开始拖动。
   *
   * @param event 指针事件。
   */
  function handlePointerMove(event: PointerEvent<HTMLButtonElement>): void {
    if (trackerRef.current.move({ x: event.clientX, y: event.clientY })) {
      draggedRef.current = true;
      void ipc.startFloatingDrag(grabRef.current ?? undefined);
    }
  }

  /** 手势结束或被取消：回到空闲，但保留 `draggedRef` 以便吞掉随后可能到来的 `click`。 */
  function handlePointerEnd(): void {
    trackerRef.current.cancel();
  }

  /** 点击：刚刚拖动过则忽略，否则打开主窗口。 */
  function handleClick(): void {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    void ipc.openMain();
  }

  /**
   * 右键：不弹 WebView 自带的菜单（后退 / 刷新 / 检查），改为快速添加待办。
   *
   * @param event 鼠标事件。
   */
  function handleContextMenu(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    onQuickAdd?.();
  }

  const status =
    remaining === null
      ? null
      : allDone
        ? t("floating.allDone")
        : t("today.badge.label", { count: remaining });
  /** 数字（或全部完成时的对勾）。 */
  const count = allDone ? (
    <CheckGlyph className={shape === "circle" ? "size-4" : "size-3.5"} />
  ) : (
    <span
      key={remaining ?? "loading"}
      aria-hidden="true"
      className={cx(
        "nv-badge-count tabular-nums",
        remaining === 0 && "text-muted",
        changed && "nv-badge-count-pop",
      )}
    >
      {remaining ?? PLACEHOLDER}
    </span>
  );

  return (
    <button
      type="button"
      aria-label={status === null ? t("floating.open") : `${t("floating.open")}，${status}`}
      aria-description={onQuickAdd ? t("floating.quickAddHint") : undefined}
      data-shape={hasSkin ? "skin" : shape}
      data-done={allDone || undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={cx(
        "nv-float nv-badge relative flex h-full w-full items-center justify-center rounded-full! text-[13px] leading-none font-semibold text-text select-none",
        hasSkin ? "gap-2 px-2 py-1" : "gap-1.5",
      )}
    >
      {hasSkin ? (
        <>
          <SkinSprite skin={skin} hovered={hovered} />
          {skin.showCount && count}
        </>
      ) : shape === "circle" ? (
        <>
          <ProgressRing progress={progress} size={36} stroke={2.5} className="absolute inset-0" />
          {count}
        </>
      ) : shape === "dot" ? (
        allDone ? (
          count
        ) : (
          <ProgressRing progress={progress} size={16} stroke={3} />
        )
      ) : (
        <>
          <ProgressRing progress={progress} size={16} stroke={3} />
          {count}
        </>
      )}
    </button>
  );
}
