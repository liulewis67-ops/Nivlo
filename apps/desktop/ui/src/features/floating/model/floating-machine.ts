/** 悬浮窗的四个状态（架构文档 §10.1）。 */
export type FloatingState = "collapsed" | "expanded" | "quickCreate" | "dragHover";

/** 驱动状态机的事件。 */
export type FloatingEvent =
  | "pointerEnter"
  | "pointerLeave"
  | "quickCreateRequested"
  | "quickCreateFinished"
  | "dragEnter"
  | "dragLeave"
  | "dropped"
  /** 需要让面板保持展开（如捕获后的「已创建」反馈）；直到收到 `holdReleased`。 */
  | "holdRequested"
  | "holdReleased"
  /** 在徽标上按下了左键（要点击或拖动，不是悬停）：取消待执行的展开，按住期间不展开。 */
  | "pressStarted"
  /** 左键松开（或指针移动时已经没有按键按着）：恢复悬停展开。 */
  | "pressEnded";

/** 指针进入后多久展开（毫秒）：太短会在鼠标"路过"时误展开（产品文档 §5.4 建议 200~300ms）。 */
export const HOVER_ENTER_DELAY_MS = 250;

/** 指针离开后多久收起（毫秒）：给"从徽标移向面板"的路径留出余量（产品文档 §5.4 约 500ms）。 */
export const HOVER_LEAVE_DELAY_MS = 500;

/** 创建状态机时的可选参数。 */
export type FloatingMachineOptions = {
  /** 指针进入到展开的延迟，默认 [`HOVER_ENTER_DELAY_MS`]。 */
  enterDelayMs?: number;
  /** 指针离开到收起的延迟，默认 [`HOVER_LEAVE_DELAY_MS`]。 */
  leaveDelayMs?: number;
};

/** 悬浮窗状态机。 */
export interface FloatingMachine {
  /** 当前状态。 */
  getState(): FloatingState;
  /** 投递一个事件。 */
  send(event: FloatingEvent): void;
  /**
   * 订阅状态变化。
   *
   * @param listener 状态变化后调用。
   * @returns 取消订阅的函数。
   */
  subscribe(listener: () => void): () => void;
  /** 清除所有待执行的计时器（组件卸载时调用）；之后状态机仍可继续使用。 */
  dispose(): void;
}

/**
 * 当前状态是否需要展开的面板窗口。
 *
 * 只有收起态是徽标大小，其余状态（展开、快速创建、拖放悬停）都需要面板空间。
 *
 * @param state 当前状态。
 * @returns 需要面板窗口时为 `true`。
 */
export function needsPanelWindow(state: FloatingState): boolean {
  return state !== "collapsed";
}

/**
 * 创建悬浮窗状态机。
 *
 * ```text
 *                Mouse Enter（延迟 250ms）
 * Collapsed ───────────────────────────→ Expanded
 *     ▲                                     │
 *     └───────── Mouse Leave（延迟 500ms）───┘
 * Expanded ── Quick Add ──→ QuickCreate（输入期间不会因指针离开而收起）
 * Collapsed / Expanded ── Drag Enter ──→ DragHover（立即响应，没有延迟）
 * Collapsed 上按下左键：取消待执行的展开，按住期间不展开（要拖动徽标，而不是打开面板）
 * ```
 *
 * 纯逻辑，与 React 解耦、可用假计时器完整测试（前端规范 §9）。所有计时器都在状态切换与
 * `dispose` 时清除，不会遗留无意义的后台 Timer。状态机本身**不发起任何 IPC**，
 * 窗口的展开 / 收起由使用它的组件根据状态去请求。
 *
 * @param options 延迟参数。
 * @returns 新的状态机，初始状态为 `collapsed`。
 */
export function createFloatingMachine(options: FloatingMachineOptions = {}): FloatingMachine {
  const enterDelayMs = options.enterDelayMs ?? HOVER_ENTER_DELAY_MS;
  const leaveDelayMs = options.leaveDelayMs ?? HOVER_LEAVE_DELAY_MS;

  let state: FloatingState = "collapsed";
  /** 指针当前是否在悬浮窗内，用于在 Quick Create / 拖放结束后决定是否需要收起。 */
  let pointerInside = false;
  /** 进入拖放悬停之前的状态，拖放结束后回到它。 */
  let stateBeforeDrag: "collapsed" | "expanded" = "collapsed";
  /** 是否有调用方要求面板保持展开；期间不会因指针离开而收起。 */
  let held = false;
  /** 徽标上的左键是否按着：按着时是在点击或拖动，悬停不展开。 */
  let pressed = false;
  let enterTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  /** 清除两个延迟计时器。 */
  function clearTimers(): void {
    if (enterTimer !== undefined) clearTimeout(enterTimer);
    if (leaveTimer !== undefined) clearTimeout(leaveTimer);
    enterTimer = undefined;
    leaveTimer = undefined;
  }

  /**
   * 切换状态并通知订阅者；状态没有变化时不通知。
   *
   * @param next 新状态。
   */
  function transition(next: FloatingState): void {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  /** 启动"离开后收起"的计时器（指针不在窗口内时）。 */
  function scheduleCollapse(): void {
    clearTimers();
    leaveTimer = setTimeout(() => {
      leaveTimer = undefined;
      if (state === "expanded" && !pointerInside && !held) transition("collapsed");
    }, leaveDelayMs);
  }

  /**
   * 回到拖放之前的状态；指针已不在窗口内且之前是展开态时，延迟收起而不是立刻消失。
   */
  function restoreAfterDrag(): void {
    transition(held ? "expanded" : stateBeforeDrag);
    if (state === "expanded" && !pointerInside) scheduleCollapse();
  }

  return {
    getState: () => state,
    send(event) {
      switch (event) {
        case "pointerEnter": {
          pointerInside = true;
          if (leaveTimer !== undefined) {
            clearTimeout(leaveTimer);
            leaveTimer = undefined;
          }
          if (state === "collapsed" && enterTimer === undefined && !pressed) {
            enterTimer = setTimeout(() => {
              enterTimer = undefined;
              if (state === "collapsed" && pointerInside) transition("expanded");
            }, enterDelayMs);
          }
          return;
        }
        case "pointerLeave": {
          pointerInside = false;
          if (enterTimer !== undefined) {
            clearTimeout(enterTimer);
            enterTimer = undefined;
          }
          // Quick Create 期间用户正在输入，指针移开不能让面板消失。
          if (state === "expanded") scheduleCollapse();
          return;
        }
        case "quickCreateRequested": {
          if (state === "collapsed" || state === "expanded") {
            clearTimers();
            transition("quickCreate");
          }
          return;
        }
        case "quickCreateFinished": {
          if (state !== "quickCreate") return;
          transition("expanded");
          if (!pointerInside) scheduleCollapse();
          return;
        }
        case "dragEnter": {
          if (state === "collapsed" || state === "expanded") {
            clearTimers();
            stateBeforeDrag = state;
            transition("dragHover");
          }
          return;
        }
        case "pressStarted": {
          pressed = true;
          if (enterTimer !== undefined) {
            clearTimeout(enterTimer);
            enterTimer = undefined;
          }
          return;
        }
        case "pressEnded": {
          pressed = false;
          return;
        }
        case "holdRequested": {
          held = true;
          if (state === "collapsed") {
            clearTimers();
            transition("expanded");
          }
          return;
        }
        case "holdReleased": {
          held = false;
          if (state === "expanded" && !pointerInside) scheduleCollapse();
          return;
        }
        case "dragLeave":
        case "dropped": {
          if (state === "dragHover") restoreAfterDrag();
          return;
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: clearTimers,
  };
}
