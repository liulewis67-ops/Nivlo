import { useRef } from "react";
import type { PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { createDragIntentTracker } from "./model/drag-intent";

/**
 * 悬浮窗收起态的徽标。
 *
 * 同一个元素承担两个交互：单击打开主窗口；按住并移动超过阈值则请求后端开始拖动窗口。
 * 拖动结束后的吸附与位置保存都在 Rust 一侧完成，这里只负责识别手势意图。
 *
 * 开始拖动后系统会接管鼠标，通常不会再收到 `click`；若仍收到，用 `draggedRef` 吞掉这一次，
 * 避免"拖完松手却打开了主窗口"。键盘激活（Enter / 空格）产生的 `click` 不受影响。
 *
 * Today 数字、Hover 展开等在实施计划 1.3 之后加入；Hover 期间不得发起任何 IPC。
 *
 * @returns 徽标按钮。
 */
export function FloatingBadge() {
  const { t } = useTranslation();
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
      aria-label={t("floating.open")}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClick={handleClick}
      className="flex h-full w-full items-center justify-center gap-2 rounded-full border border-border bg-surface text-sm font-medium text-text shadow-md select-none"
    >
      <span aria-hidden="true" className="size-2.5 rounded-full bg-primary" />
      <span>{t("app.name")}</span>
    </button>
  );
}
