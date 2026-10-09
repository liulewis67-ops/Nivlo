/** 判定为"拖动"所需的最小移动距离（px）；小于它的移动视为手抖，仍然是点击。 */
export const DRAG_THRESHOLD_PX = 4;

/** 指针位置。 */
export type PointerPoint = { x: number; y: number };

/** 一次按下-抬起过程中的阶段。 */
export type DragPhase = "idle" | "pressed" | "dragging";

/** 抬起时对整个手势的判定。 */
export type GestureResult = "click" | "drag" | "none";

/** 区分点击与拖动的跟踪器。 */
export interface DragIntentTracker {
  /** 当前阶段。 */
  readonly phase: DragPhase;
  /** 按下指针，开始一次手势。 */
  press(point: PointerPoint): void;
  /**
   * 报告指针移动。
   *
   * @returns 仅在这次移动**刚好**跨过阈值、手势变成拖动的那一刻返回 `true`，
   *   之后（以及未跨过阈值时）返回 `false`，调用方据此只触发一次"开始拖动"。
   */
  move(point: PointerPoint): boolean;
  /** 抬起指针，返回整个手势的判定，并回到空闲状态。 */
  release(): GestureResult;
  /** 取消手势（指针离开、被系统取消等），回到空闲状态。 */
  cancel(): void;
}

/**
 * 创建区分点击与拖动的跟踪器。
 *
 * 悬浮窗徽标同时承担两个交互：单击打开主窗口、按住拖动移动位置。
 * 只有指针从按下点移动超过阈值才算拖动，否则抬起时就是一次点击（产品文档 §5.2）。
 * 纯逻辑，不依赖 React 与 DOM，便于单元测试（前端规范 §9）。
 *
 * @param thresholdPx 判定为拖动的最小距离（px），默认 [`DRAG_THRESHOLD_PX`]。
 * @returns 新的跟踪器。
 */
export function createDragIntentTracker(
  thresholdPx: number = DRAG_THRESHOLD_PX,
): DragIntentTracker {
  let phase: DragPhase = "idle";
  let origin: PointerPoint = { x: 0, y: 0 };

  return {
    get phase() {
      return phase;
    },
    press(point) {
      phase = "pressed";
      origin = point;
    },
    move(point) {
      if (phase !== "pressed") return false;
      if (Math.hypot(point.x - origin.x, point.y - origin.y) < thresholdPx) return false;
      phase = "dragging";
      return true;
    },
    release() {
      const result: GestureResult =
        phase === "pressed" ? "click" : phase === "dragging" ? "drag" : "none";
      phase = "idle";
      return result;
    },
    cancel() {
      phase = "idle";
    },
  };
}
