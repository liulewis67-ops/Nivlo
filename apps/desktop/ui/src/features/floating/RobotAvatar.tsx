import { useMemo } from "react";
import type { Skin } from "@/stores/skin-store";
import { useFrameTimeline, usePageVisible, useReducedMotion } from "./model/frame-timeline";
import type { AnimationSlot, AnimationTrigger } from "./model/frame-timeline";
import { DEFAULT_ROBOT_ACTION, resolveRobotSequence } from "./model/robot-actions";
import type { RobotActionConfig, RobotEyeState } from "./model/robot-actions";

/** 取自悬浮窗交互或待办的角色状态。 */
export type RobotExpression = AnimationSlot;
/** 与图片帧设置无关的内置角色外观。 */
type RobotAppearance = Pick<Skin, "robot" | "color" | "face">;

const PALETTES = {
  steel: ["#cbd4de", "#7590ae", "#83ceff"],
  mint: ["#b8f4dc", "#54b7a0", "#d2fff0"],
  amber: ["#ffd597", "#db8842", "#fff0be"],
  lilac: ["#e4d7ff", "#9a81d1", "#f9e9ff"],
  pearl: ["#f7f1df", "#b6ad96", "#fffbed"],
} as const;

const ORIGINAL_COLORS = { scout: "steel", relay: "amber", memo: "pearl" } as const;

/** 渲染机器人眼部表情。 */
function renderEyes({
  eyeState,
  face,
  narrow,
}: {
  eyeState: RobotEyeState;
  face: RobotAppearance["face"];
  narrow: number;
}) {
  if (eyeState === "check") {
    return <path d="m19.5 21 3 3 6-6" strokeWidth="2.2" />;
  }
  if (eyeState === "drop") {
    return <path d="M24 17v7m-3-3 3 3 3-3" />;
  }
  if (eyeState === "blink" || eyeState === "sleep") {
    return (
      <>
        <path d="M16.5 21.5h5" />
        <path d="M26.5 21.5h5" />
      </>
    );
  }
  if (eyeState === "half") {
    return (
      <>
        <path d="M19 20.5v2" />
        <path d="M29 20.5v2" />
      </>
    );
  }
  if (eyeState === "happy") {
    return (
      <>
        <path d="m16.5 22 2.5-3 2.5 3" />
        <path d="m26.5 22 2.5-3 2.5 3" />
        {face === "friendly" && <path d="M23 24h2" strokeWidth="1" />}
      </>
    );
  }
  const shift = eyeState === "lookLeft" ? -1.8 : eyeState === "lookRight" ? 1.8 : 0;
  return (
    <>
      <path d={`M${19 + shift} ${21 - narrow}v${narrow * 2}`} />
      <path
        d={
          face === "playful" && shift === 0
            ? "m26.5 22 2.5-3 2.5 3"
            : `M${29 + shift} ${21 - narrow}v${narrow * 2}`
        }
      />
      {face === "friendly" && <path d={`M${23 + shift * 0.5} 24h2`} strokeWidth="1" />}
    </>
  );
}

/**
 * 用相同的几何部件与统一帧动画引擎渲染设置预览和桌面伙伴。
 *
 * `viewBox` 四周预留安全边距（`-3 -3 54 42`），确保所有头部动作与装饰不超出透明窗口边界。
 *
 * @param props 外形、配色、表情、动作配置与当前交互状态。
 * @returns 透明背景的角色图形。
 */
export function RobotAvatar({
  appearance,
  expression = "idle",
  action = DEFAULT_ROBOT_ACTION,
  animationEnabled = false,
  trigger = "interactive",
  hovered = false,
}: {
  appearance: RobotAppearance;
  expression?: RobotExpression;
  action?: RobotActionConfig;
  animationEnabled?: boolean;
  trigger?: AnimationTrigger;
  hovered?: boolean;
}) {
  const { robot, color, face } = appearance;
  const visible = usePageVisible();
  const reducedMotion = useReducedMotion();

  const sequence = useMemo(
    () =>
      resolveRobotSequence({
        slot: expression,
        action,
        animationEnabled: animationEnabled && visible && !reducedMotion,
        trigger,
        hovered: hovered || expression === "hover",
      }),
    [expression, action, animationEnabled, visible, reducedMotion, trigger, hovered],
  );

  const frameDurations = useMemo(
    () => sequence.frames.map((frame) => frame.durationMs),
    [sequence.frames],
  );
  const resetKey = `${expression}:${action.idle}:${sequence.playback}:${sequence.active ? "1" : "0"}`;
  const frameIndex = useFrameTimeline({
    frameDurations,
    playback: sequence.playback,
    active: sequence.active,
    resetKey,
  });
  const pose = sequence.frames[frameIndex] ??
    sequence.frames[0] ?? {
      durationMs: 1000,
      eyeState: "open" as const,
    };

  const [shell, edge, light] = PALETTES[color === "original" ? ORIGINAL_COLORS[robot] : color];
  const ink = "#182a34";
  const signal =
    pose.signalBright || expression === "grabbed" || expression === "ready" ? "#ffe18d" : light;
  const narrow = face === "focused" ? 1.25 : 2.75;

  const transforms: string[] = [];
  if (pose.headOffsetY) transforms.push(`translate(0 ${pose.headOffsetY})`);
  if (pose.headTiltDeg) transforms.push(`rotate(${pose.headTiltDeg} 24 21)`);
  if (pose.headScale && pose.headScale !== 1) {
    transforms.push(`translate(24 21) scale(${pose.headScale}) translate(-24 -21)`);
  }
  const headTransform = transforms.length > 0 ? transforms.join(" ") : undefined;

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="-3 -3 54 42"
      className="nv-robot pointer-events-none size-full"
      data-expression={expression}
      data-frame={frameIndex}
      fill="none"
    >
      <path d="M15 30h18v3.5a1 1 0 0 1-1 1H16a1 1 0 0 1-1-1Z" fill={edge} stroke={ink} />
      <g className="nv-robot-head" strokeLinejoin="round" transform={headTransform}>
        {robot === "scout" && (
          <>
            <path d="M25 11V7l5-3" stroke={ink} strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="31" cy="3.5" r="2.4" fill={signal} stroke={ink} strokeWidth="1.2" />
            <path d="M10 16H6v10h4m28-10h4v10h-4" fill={edge} stroke={ink} strokeWidth="1.4" />
            <path
              d="M14 10h20l5 5v12l-5 5H14l-5-5V15Z"
              fill={shell}
              stroke={ink}
              strokeWidth="1.5"
            />
          </>
        )}
        {robot === "relay" && (
          <>
            <path
              d="M18 10V6h12v4M7 17h5v10H7zm29 0h5v10h-5z"
              fill={edge}
              stroke={ink}
              strokeWidth="1.5"
            />
            <path d="M11 13l4-4h18l4 4v17H11Z" fill={shell} stroke={ink} strokeWidth="1.5" />
            <path d="M14 29h20" stroke={edge} strokeWidth="2" />
          </>
        )}
        {robot === "memo" && (
          <>
            <path d="M15 11V5h10l5 5v4" fill={signal} stroke={ink} strokeWidth="1.5" />
            <path d="M25 5v5h5" stroke={ink} />
            <rect
              x="7.5"
              y="10"
              width="33"
              height="22"
              rx="9"
              fill={shell}
              stroke={ink}
              strokeWidth="1.5"
            />
          </>
        )}
        <rect
          x="12"
          y="14"
          width="24"
          height="14"
          rx={robot === "memo" ? 5 : 2.5}
          fill="#193749"
          stroke={ink}
          strokeWidth="1"
        />
        <g stroke={signal} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          {renderEyes({ eyeState: pose.eyeState, face, narrow })}
        </g>
      </g>
      {pose.fx === "zzz" && (
        <g stroke={signal} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M38 5h3.5L38 8.5h3.5" />
          <path d="M43 1.5h3L43 4.5h3" />
        </g>
      )}
      {pose.fx === "sparkle" && (
        <g stroke={signal} strokeWidth="1.4" strokeLinecap="round">
          <path d="M4 5v4M2 7h4" />
          <path d="M44 4v4M42 6h4" />
        </g>
      )}
    </svg>
  );
}
