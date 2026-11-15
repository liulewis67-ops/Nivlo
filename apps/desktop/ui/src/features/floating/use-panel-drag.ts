import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { ipc } from "@/lib/ipc";
import { LONG_PRESS_MS, createDragIntentTracker } from "./model/drag-intent";

/**
 * 按在这些元素上不拿起面板：它们有自己的按下 / 拖动含义（按钮、输入框、可排序的待办、菜单等）。
 * 其他地方（标题、空白、说明文字）长按都可以拿起整个悬浮窗。
 */
const OWN_GESTURE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "label",
  "[role='button']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='slider']",
  "[contenteditable='true']",
  "[aria-roledescription='sortable']",
  "[data-no-window-drag]",
].join(", ");

/**
 * 这次按下是否落在有自己手势的元素上。
 *
 * @param target 按下的元素。
 * @returns 是则不拿起面板。
 */
export function hasOwnGesture(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OWN_GESTURE_SELECTOR) !== null;
}

/** [`usePanelDrag`] 的返回值。 */
export type PanelDrag = {
  /** 已长按拿起：面板换成"拿起来了"的样子，接下来的移动会拖动整个悬浮窗。 */
  selected: boolean;
  /** 绑定到面板根元素的指针处理器。 */
  handlers: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  };
};

/**
 * 展开的面板也能像徽标一样长按拿起、拖到任意位置：按住面板的空白处（标题、留白）
 * [`LONG_PRESS_MS`] 不动即拿起，再移动就交给系统拖动窗口；收起后徽标出现在面板被放下的地方（后端负责）。
 * 没长按就移动不拖动（避免滑动、选字时误挪窗口）；按在按钮、输入框、待办上不响应。
 *
 * @returns 拿起状态与处理器。
 */
export function usePanelDrag(): PanelDrag {
  const trackerRef = useRef(createDragIntentTracker());
  const longPressRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 按下的位置（窗口内坐标）：开始拖动时交给后端，让按住的那一点留在光标下。 */
  const grabRef = useRef<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState(false);

  useEffect(() => () => clearTimeout(longPressRef.current), []);

  /** 结束这次手势：清掉长按计时并放下。 */
  function reset(): void {
    clearTimeout(longPressRef.current);
    longPressRef.current = undefined;
    setSelected(false);
  }

  /** 按下：不在有自己手势的元素上时开始长按计时。 */
  function onPointerDown(event: PointerEvent<HTMLElement>): void {
    if (event.button !== 0 || hasOwnGesture(event.target)) return;
    grabRef.current = { x: event.clientX, y: event.clientY };
    trackerRef.current.press({ x: event.clientX, y: event.clientY });
    reset();
    longPressRef.current = setTimeout(() => {
      longPressRef.current = undefined;
      if (trackerRef.current.select()) setSelected(true);
    }, LONG_PRESS_MS);
    // 第一次移动可能已经越过面板边缘，仍需要收到事件才能交给系统拖动。
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  /**
   * 释放指针捕获，让系统接管拖动，或结束本次手势。
   * @param event 本次手势的指针事件。
   */
  function releasePointer(event: PointerEvent<HTMLElement>): void {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  /**
   * 移动：拿起后跨过阈值的那一刻请求后端开始拖动；没拿起就移动则放弃这次手势。
   * 原生拖动结束时页面收不到 `pointerup`：之后的移动已经没有按键按着，就当作松开了。
   */
  function onPointerMove(event: PointerEvent<HTMLElement>): void {
    const tracker = trackerRef.current;
    if (tracker.phase === "idle") return;
    if (event.buttons === 0) {
      releasePointer(event);
      tracker.cancel();
      reset();
      return;
    }
    const starts = tracker.move({ x: event.clientX, y: event.clientY });
    if (tracker.phase === "abandoned") {
      releasePointer(event);
      reset();
    }
    if (starts) {
      releasePointer(event);
      // 文字可能已被按住选中了一点：拖动窗口时不要带着选区。
      window.getSelection()?.removeAllRanges();
      void ipc.startFloatingDrag(grabRef.current ?? undefined);
    }
  }

  /**
   * 松开或被取消：回到空闲并放下。
   * @param event 本次手势的指针事件。
   */
  function onPointerEnd(event: PointerEvent<HTMLElement>): void {
    releasePointer(event);
    trackerRef.current.release();
    reset();
  }

  return {
    selected,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
  };
}
