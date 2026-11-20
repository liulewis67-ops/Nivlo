import type { AnimationSlot, AnimationTrigger, TrackPlayback } from "./frame-timeline";

/** 悬浮机器人待机动作预设。 */
export const ROBOT_IDLE_ACTIONS = [
  "off",
  "blink",
  "float",
  "breathe",
  "lookAround",
  "sleep",
] as const;
/** 待机动作名。 */
export type RobotIdleAction = (typeof ROBOT_IDLE_ACTIONS)[number];

/** 悬浮机器人的动作配置。 */
export type RobotActionConfig = {
  idle: RobotIdleAction;
  hover: boolean;
  grabbed: boolean;
  ready: boolean;
  done: boolean;
  reminder: boolean;
};

/** 默认机器人动作：轻量自然眨眼 + 交互反馈。 */
export const DEFAULT_ROBOT_ACTION: RobotActionConfig = {
  idle: "blink",
  hover: true,
  grabbed: true,
  ready: true,
  done: true,
  reminder: true,
};

/** 机器人单帧眼部形态。 */
export type RobotEyeState =
  "open" | "half" | "blink" | "happy" | "lookLeft" | "lookRight" | "check" | "drop" | "sleep";

/** 机器人离散关键帧：所有位移与倾角严格限制在安全区内，防止被透明窗口裁切。 */
export type RobotPoseFrame = {
  /** 本帧持续时间（ms）。 */
  durationMs: number;
  /** 头部纵向位移（SVG 单位，范围 [-1.5, 1.5]）。 */
  headOffsetY?: number;
  /** 头部倾角（度，范围 [-4, 4]）。 */
  headTiltDeg?: number;
  /** 头部轻微缩放（范围 [0.97, 1.03]）。 */
  headScale?: number;
  /** 眼部形态。 */
  eyeState: RobotEyeState;
  /** 天线 / 指示灯高亮。 */
  signalBright?: boolean;
  /** 局部小装饰（如打盹 Zzz / 完成闪星）。 */
  fx?: "none" | "zzz" | "sparkle";
};

const STATIC_IDLE_FRAME: RobotPoseFrame = { durationMs: 1000, eyeState: "open" };
const STATIC_HOVER_FRAME: RobotPoseFrame = {
  durationMs: 1000,
  headOffsetY: -0.8,
  eyeState: "happy",
};
const STATIC_GRABBED_FRAME: RobotPoseFrame = {
  durationMs: 1000,
  headOffsetY: -0.8,
  eyeState: "happy",
  signalBright: true,
};
const STATIC_READY_FRAME: RobotPoseFrame = {
  durationMs: 1000,
  eyeState: "drop",
  signalBright: true,
};
const STATIC_DONE_FRAME: RobotPoseFrame = { durationMs: 1000, eyeState: "check" };
const STATIC_IDLE: readonly RobotPoseFrame[] = [STATIC_IDLE_FRAME];

/** 各待机动作的离散帧序列。 */
const IDLE_SEQUENCES: Record<RobotIdleAction, readonly RobotPoseFrame[]> = {
  off: STATIC_IDLE,
  blink: [
    { durationMs: 2600, eyeState: "open" },
    { durationMs: 90, eyeState: "half" },
    { durationMs: 120, eyeState: "blink", signalBright: true },
    { durationMs: 90, eyeState: "half" },
  ],
  float: [
    { durationMs: 550, headOffsetY: 0, eyeState: "open" },
    { durationMs: 550, headOffsetY: -0.8, eyeState: "open" },
    { durationMs: 600, headOffsetY: -1.4, eyeState: "open", signalBright: true },
    { durationMs: 550, headOffsetY: -0.8, eyeState: "open" },
  ],
  breathe: [
    { durationMs: 700, headScale: 1, eyeState: "open" },
    { durationMs: 700, headScale: 1.025, headOffsetY: -0.4, eyeState: "open", signalBright: true },
    { durationMs: 700, headScale: 1, eyeState: "open" },
    { durationMs: 700, headScale: 0.985, headOffsetY: 0.3, eyeState: "open" },
  ],
  lookAround: [
    { durationMs: 1600, eyeState: "open" },
    { durationMs: 750, headTiltDeg: -3, eyeState: "lookLeft" },
    { durationMs: 300, eyeState: "open" },
    { durationMs: 750, headTiltDeg: 3, eyeState: "lookRight", signalBright: true },
    { durationMs: 120, eyeState: "blink" },
  ],
  sleep: [
    { durationMs: 1100, headOffsetY: 0.6, headTiltDeg: -2, eyeState: "sleep" },
    { durationMs: 1100, headOffsetY: 1.1, headTiltDeg: -3, eyeState: "sleep", fx: "zzz" },
  ],
};

/** 各交互/状态反馈动作的离散帧序列。 */
const REACTIVE_SEQUENCES: Record<
  Exclude<AnimationSlot, "idle">,
  { frames: readonly RobotPoseFrame[]; playback: TrackPlayback }
> = {
  hover: {
    playback: "loop",
    frames: [
      {
        durationMs: 360,
        headOffsetY: -1.1,
        headTiltDeg: -2,
        eyeState: "happy",
        signalBright: true,
      },
      { durationMs: 360, headOffsetY: -0.6, headTiltDeg: 2, eyeState: "happy" },
    ],
  },
  grabbed: {
    playback: "loop",
    frames: [
      {
        durationMs: 180,
        headOffsetY: -1.2,
        headTiltDeg: -4,
        eyeState: "happy",
        signalBright: true,
      },
      { durationMs: 180, headOffsetY: -0.8, headTiltDeg: 4, eyeState: "happy", signalBright: true },
    ],
  },
  ready: {
    playback: "loop",
    frames: [
      { durationMs: 280, headOffsetY: -1.0, eyeState: "drop", signalBright: true },
      { durationMs: 280, headOffsetY: 0.2, eyeState: "drop", signalBright: true },
    ],
  },
  done: {
    playback: "once",
    frames: [
      { durationMs: 140, headOffsetY: 0.4, headScale: 0.97, eyeState: "check", signalBright: true },
      {
        durationMs: 220,
        headOffsetY: -1.5,
        headScale: 1.03,
        eyeState: "check",
        signalBright: true,
        fx: "sparkle",
      },
      { durationMs: 180, headOffsetY: 0, headScale: 1, eyeState: "check", fx: "sparkle" },
      { durationMs: 1000, headOffsetY: 0, headScale: 1, eyeState: "check" },
    ],
  },
  reminder: {
    playback: "loop",
    frames: [
      { durationMs: 160, headOffsetY: -1.2, headTiltDeg: -4, eyeState: "open", signalBright: true },
      { durationMs: 160, headOffsetY: -1.2, headTiltDeg: 4, eyeState: "happy", signalBright: true },
      { durationMs: 220, headOffsetY: 0, headTiltDeg: 0, eyeState: "open" },
    ],
  },
};

/** 静态兜底帧（动画关闭或该交互动作被单独关闭时显示）。 */
export function staticRobotFrame(slot: AnimationSlot): RobotPoseFrame {
  switch (slot) {
    case "hover":
      return STATIC_HOVER_FRAME;
    case "grabbed":
      return STATIC_GRABBED_FRAME;
    case "ready":
      return STATIC_READY_FRAME;
    case "done":
      return STATIC_DONE_FRAME;
    case "reminder":
      return { durationMs: 1000, eyeState: "open", signalBright: true };
    case "idle":
      return STATIC_IDLE_FRAME;
  }
}

/**
 * 解析当前状态槽位下机器人应播放的帧序列与是否激活调度。
 *
 * @param params 当前槽位、动作配置、全局开关、触发策略与悬停状态。
 * @returns 帧序列、播放模式与是否激活。
 */
export function resolveRobotSequence({
  slot,
  action,
  animationEnabled,
  trigger,
  hovered,
}: {
  slot: AnimationSlot;
  action: RobotActionConfig;
  animationEnabled: boolean;
  trigger: AnimationTrigger;
  hovered: boolean;
}): { frames: readonly RobotPoseFrame[]; playback: TrackPlayback; active: boolean } {
  if (!animationEnabled) {
    return { frames: [staticRobotFrame(slot)], playback: "still", active: false };
  }
  if (trigger === "hoverOnly" && !hovered && slot !== "reminder" && slot !== "grabbed") {
    return { frames: [staticRobotFrame(slot)], playback: "still", active: false };
  }

  if (slot !== "idle") {
    if (!action[slot]) {
      return { frames: [staticRobotFrame(slot)], playback: "still", active: false };
    }
    const seq = REACTIVE_SEQUENCES[slot];
    return { frames: seq.frames, playback: seq.playback, active: true };
  }

  if (action.idle === "off") {
    return { frames: STATIC_IDLE, playback: "still", active: false };
  }
  // interactive 模式下允许低频 blink/sleep 待机，其余持续位移类仅在 always 时待机播放。
  const idleAllowed =
    trigger === "always" ||
    (trigger === "interactive" && (action.idle === "blink" || action.idle === "sleep"));
  if (!idleAllowed) {
    return { frames: STATIC_IDLE, playback: "still", active: false };
  }
  return { frames: IDLE_SEQUENCES[action.idle], playback: "loop", active: true };
}
