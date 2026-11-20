import { useEffect, useState } from "react";

/** 悬浮窗动画状态槽位，按优先级从高到低：reminder > grabbed > ready > done > hover > idle。 */
export const ANIMATION_SLOTS = ["idle", "hover", "grabbed", "ready", "done", "reminder"] as const;
/** 动画状态槽位名。 */
export type AnimationSlot = (typeof ANIMATION_SLOTS)[number];

/** 全局动画触发策略：交互与提醒（默认节能）、始终播放、仅悬停时播放。 */
export const ANIMATION_TRIGGERS = ["interactive", "always", "hoverOnly"] as const;
/** 触发策略名。 */
export type AnimationTrigger = (typeof ANIMATION_TRIGGERS)[number];

/** 单轨道播放模式：循环、往返、单次、静止。 */
export const TRACK_PLAYBACKS = ["loop", "pingpong", "once", "still"] as const;
/** 单轨道播放模式名。 */
export type TrackPlayback = (typeof TRACK_PLAYBACKS)[number];

/** 当前悬浮窗交互与业务状态快照。 */
export type AnimationStateFlags = {
  reminder?: boolean;
  grabbed?: boolean;
  ready?: boolean;
  done?: boolean;
  hovered?: boolean;
};

/**
 * 按优先级解析当前应激活的动画槽位。
 *
 * @param flags 悬浮窗状态标志。
 * @returns 最高优先级的状态槽位。
 */
export function resolveAnimationSlot(flags: AnimationStateFlags): AnimationSlot {
  if (flags.reminder) return "reminder";
  if (flags.grabbed) return "grabbed";
  if (flags.ready) return "ready";
  if (flags.done) return "done";
  if (flags.hovered) return "hover";
  return "idle";
}

/**
 * 计算下一帧下标、方向与是否已完成（仅 `once` 模式会在末帧后结束）。
 *
 * @param index 当前帧下标。
 * @param length 总帧数。
 * @param playback 播放模式。
 * @param direction 当前方向（`pingpong` 用）。
 * @returns 下一帧状态。
 */
export function stepFrame(
  index: number,
  length: number,
  playback: TrackPlayback,
  direction: 1 | -1,
): { index: number; direction: 1 | -1; finished: boolean } {
  if (length <= 1 || playback === "still") {
    return { index: 0, direction: 1, finished: true };
  }
  if (playback === "once") {
    if (index + 1 >= length) return { index: length - 1, direction: 1, finished: true };
    return { index: index + 1, direction: 1, finished: false };
  }
  if (playback === "pingpong") {
    let dir = direction;
    if (index + dir >= length || index + dir < 0) dir = dir === 1 ? -1 : 1;
    return { index: index + dir, direction: dir, finished: false };
  }
  return { index: (index + 1) % length, direction: 1, finished: false };
}

/** 监听页面可见性；隐藏时停止一切调度计时器（D-13）。 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    /** 同步页面可见性。 */
    const onChange = (): void => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/** 监听系统「减少动态效果」偏好。 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    /** 同步减少动态效果设置。 */
    const onChange = (): void => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * 可变时长帧调度 Hook：按每帧自身的 `durationMs` 链式 `setTimeout` 步进。
 *
 * `active` 为假、帧数 <= 1 或 `playback === "still"` 时不创建任何定时器。
 *
 * @param options 帧时长数组、播放模式、是否激活及重置键。
 * @returns 当前应展示的帧下标。
 */
export function useFrameTimeline({
  frameDurations,
  playback,
  active,
  resetKey,
}: {
  frameDurations: readonly number[];
  playback: TrackPlayback;
  active: boolean;
  resetKey: string;
}): number {
  const [cursor, setCursor] = useState<{
    key: string;
    index: number;
    direction: 1 | -1;
    finished: boolean;
  }>({ key: resetKey, index: 0, direction: 1, finished: false });

  const current =
    cursor.key === resetKey
      ? cursor
      : { key: resetKey, index: 0, direction: 1 as 1 | -1, finished: false };
  const safeIndex = frameDurations.length > 0 ? current.index % frameDurations.length : 0;
  const shouldTick =
    active && frameDurations.length > 1 && playback !== "still" && !current.finished;
  const delayMs = Math.max(16, Math.round(frameDurations[safeIndex] ?? 100));

  useEffect(() => {
    if (!shouldTick) return;
    const timer = window.setTimeout(() => {
      const next = stepFrame(safeIndex, frameDurations.length, playback, current.direction);
      setCursor({
        key: resetKey,
        index: next.index,
        direction: next.direction,
        finished: next.finished,
      });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [
    shouldTick,
    delayMs,
    safeIndex,
    frameDurations.length,
    playback,
    current.direction,
    resetKey,
  ]);

  return active ? safeIndex : 0;
}
