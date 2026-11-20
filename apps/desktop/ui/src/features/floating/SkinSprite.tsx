import { useEffect, useMemo } from "react";
import { cx } from "@/lib/cx";
import { resolveSkinTrack } from "@/stores/skin-store";
import type { AnimationSlot, Skin } from "@/stores/skin-store";
import { useFrameTimeline, usePageVisible, useReducedMotion } from "./model/frame-timeline";

/** [`SkinSprite`] 的 Props。 */
type SkinSpriteProps = {
  skin: Skin;
  /** 当前交互与业务状态槽位；未指定时按 `idle` 处理。 */
  slot?: AnimationSlot;
  /** 是否正被悬停；播放方式或触发策略为仅悬停时才会动。 */
  hovered?: boolean;
  className?: string;
};

/**
 * 按用户设置逐帧播放自定义皮肤（支持本地文件协议与旧版内联兜底），并叠加漂浮 / 呼吸 / 弹跳等附加动效。
 *
 * 全局关闭动画、页面隐藏或系统开启「减少动态效果」时只显示首帧且不创建任何定时器（D-13）。
 *
 * @param props 皮肤、状态槽位与悬停状态。
 * @returns 皮肤图像；没有帧时返回 `null`。
 */
export function SkinSprite({ skin, slot = "idle", hovered = false, className }: SkinSpriteProps) {
  const visible = usePageVisible();
  const reducedMotion = useReducedMotion();
  const resolved = useMemo(() => resolveSkinTrack(skin, slot), [skin, slot]);

  // 预热当前活跃轨道的帧图，切帧时避免闪烁。
  useEffect(() => {
    for (const frame of resolved.frames) {
      if (!frame.src.startsWith("data:")) {
        const img = new Image();
        img.src = frame.src;
      }
    }
  }, [resolved.frames]);

  const canAnimate = visible && !reducedMotion && skin.animationEnabled;
  const triggerAllows = !resolved.hoverOnly || hovered || slot === "reminder" || slot === "grabbed";
  const playing =
    canAnimate && resolved.frames.length > 1 && resolved.playback !== "still" && triggerAllows;

  const frameDurations = useMemo(
    () => resolved.frames.map((frame) => frame.durationMs),
    [resolved.frames],
  );
  const resetKey = `${slot}:${resolved.playback}:${resolved.frames.length}:${playing ? "1" : "0"}`;
  const frameIndex = useFrameTimeline({
    frameDurations,
    playback: resolved.playback,
    active: playing,
    resetKey,
  });

  const src = resolved.frames[playing ? frameIndex % resolved.frames.length : 0]?.src;
  if (src === undefined) return null;

  const motionAllowed =
    canAnimate &&
    skin.motion !== "none" &&
    (skin.animationTrigger !== "hoverOnly" || hovered || slot === "reminder" || slot === "grabbed");

  return (
    <img
      src={src}
      role="presentation"
      aria-hidden="true"
      draggable={false}
      className={cx(
        "nv-skin h-full max-h-full w-auto object-contain",
        skin.pixel && "nv-skin-pixel",
        motionAllowed && `nv-skin-${skin.motion}`,
        className,
      )}
    />
  );
}
