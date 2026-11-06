/** 判定为"移动"所需的最小距离（px）；小于它的移动视为手抖，仍然是点击 / 长按。 */
export const DRAG_THRESHOLD_PX = 4;

/** 按住多久算长按（毫秒）：长按选中徽标之后才能拖动它。 */
export const LONG_PRESS_MS = 400;

/** 指针位置。 */
export type PointerPoint = { x: number; y: number };

/**
 * 一次按下-抬起过程中的阶段。
 *
 * - `pressed`：刚按下，还不知道是点击还是长按；
 * - `selected`：已长按选中，接下来的移动会拖动徽标；
 * - `dragging`：已经开始拖动；
 * - `abandoned`：没长按就移动了，这次手势既不是点击也不拖动（防止误拖）。
 */
export type DragPhase = "idle" | "pressed" | "selected" | "dragging" | "abandoned";

/** 抬起时对整个手势的判定。 */
export type GestureResult = "click" | "drag" | "none";

/** 区分点击、长按选中与拖动的跟踪器。 */
export interface DragIntentTracker {
  /** 当前阶段。 */
  readonly phase: DragPhase;
  /** 按下指针，开始一次手势。 */
  press(point: PointerPoint): void;
  /**
   * 长按计时到点：仍在按住且没有移动时进入选中态。
   *
   * @returns 刚刚进入选中态时返回 `true`。
   */
  select(): boolean;
  /**
   * 报告指针移动。
   *
   * @returns 仅在选中后这次移动**刚好**跨过阈值、手势变成拖动的那一刻返回 `true`，
   *   其余情况返回 `false`，调用方据此只触发一次"开始拖动"。没选中就跨过阈值会放弃本次手势。
   */
  move(point: PointerPoint): boolean;
  /** 抬起指针，返回整个手势的判定，并回到空闲状态。 */
  release(): GestureResult;
  /** 取消手势（指针离开、被系统取消等），回到空闲状态。 */
  cancel(): void;
}

/**
 * 创建区分点击、长按选中与拖动的跟踪器。
 *
 * 悬浮窗徽标同时承担两个交互：单击打开主窗口、长按选中后拖动到任意位置。
 * 没有长按就移动不会拖动（避免点击时手一滑就把徽标挪走），也不算点击；
 * 长按后不移动直接松开只是取消选中。纯逻辑，不依赖 React、DOM 与计时器，
 * 长按计时由调用方负责并在到点时调用 [`DragIntentTracker.select`]（前端规范 §9）。
 *
 * @param thresholdPx 判定为移动的最小距离（px），默认 [`DRAG_THRESHOLD_PX`]。
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
    select() {
      if (phase !== "pressed") return false;
      phase = "selected";
      return true;
    },
    move(point) {
      if (phase !== "pressed" && phase !== "selected") return false;
      if (Math.hypot(point.x - origin.x, point.y - origin.y) < thresholdPx) return false;
      if (phase === "pressed") {
        phase = "abandoned";
        return false;
      }
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
