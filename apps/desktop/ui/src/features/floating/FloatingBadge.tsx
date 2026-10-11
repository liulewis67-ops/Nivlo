import { useRef, useState } from "react";
import type { PointerEvent } from "react";
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

/**
 * 悬浮窗收起态的徽标：显示今天还剩多少个待办（"● 4"，产品文档 §5.1）。
 *
 * 同一个元素承担两个交互：单击打开主窗口；按住并移动超过阈值则请求后端开始拖动窗口。
 * 拖动结束后的吸附与位置保存都在 Rust 一侧完成，这里只负责识别手势意图。
 *
 * 开始拖动后系统会接管鼠标，通常不会再收到 `click`；若仍收到，用 `draggedRef` 吞掉这一次，
 * 避免"拖完松手却打开了主窗口"。键盘激活（Enter / 空格）产生的 `click` 不受影响。
 *
 * 数字来自 Today 的查询缓存，由后端事件刷新；渲染徽标不会发起任何 IPC。
 *
 * @returns 徽标按钮。
 */
export function FloatingBadge() {
  const { t } = useTranslation();
  const today = useTodayQuery();
  /** 今天还剩的待办数；尚未加载完成时为 `null`，显示占位而不是误导性的 0。 */
  const remaining = today.data?.remainingCount ?? null;
  const shape = useAppearanceStore((state) => state.appearance.badgeShape);
  const skin = useSkinStore((state) => state.skin);
  const [hovered, setHovered] = useState(false);
  const hasSkin = skin.frames.length > 0;
  const trackerRef = useRef(createDragIntentTracker());
  const draggedRef = useRef(false);

  /**
   * 记录按下位置，开始一次新手势。
   *
   * @param event 指针事件；只响应主键（左键）。
   */
  function handlePointerDown(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    draggedRef.current = false;
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
      void ipc.startFloatingDrag();
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

  return (
    <button
      type="button"
      aria-label={
        remaining === null
          ? t("floating.open")
          : `${t("floating.open")}，${t("today.badge.label", { count: remaining })}`
      }
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClick={handleClick}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={cx(
        "nv-float nv-badge flex h-full w-full items-center justify-center gap-2 rounded-full! text-sm font-semibold text-text select-none",
        hasSkin && "px-2 py-1",
      )}
    >
      {hasSkin && <SkinSprite skin={skin} hovered={hovered} />}
      {!hasSkin && shape !== "circle" && (
        <span
          aria-hidden="true"
          className={cx(
            "nv-badge-dot rounded-full bg-primary",
            shape === "dot" ? "size-4" : "size-2.5",
          )}
        />
      )}
      {(hasSkin ? skin.showCount : shape !== "dot") && (
        <span aria-hidden="true" className="tabular-nums">
          {remaining ?? PLACEHOLDER}
        </span>
      )}
    </button>
  );
}
