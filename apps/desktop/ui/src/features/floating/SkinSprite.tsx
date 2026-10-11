import { useEffect, useState } from "react";
import { cx } from "@/lib/cx";
import { nextFrame } from "@/stores/skin-store";
import type { Skin } from "@/stores/skin-store";

/** [`SkinSprite`] 的 Props。 */
type SkinSpriteProps = {
  skin: Skin;
  /** 是否正被悬停；播放方式为 `hover` 时才会动。 */
  hovered?: boolean;
  className?: string;
};

/** 系统是否开启「减少动态效果」。 */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 页面是否可见；隐藏时停止计时器与动画（D-13）。 */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    /** 同步可见性。 */
    const onChange = (): void => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * 按用户设置逐帧播放自定义皮肤，并叠加漂浮 / 呼吸 / 弹跳等附加动效。
 *
 * 系统开启"减少动态效果"时只显示第一帧（见 global.css）。
 *
 * @param props 皮肤与悬停状态。
 * @returns 皮肤图像；没有帧时返回 `null`。
 */
export function SkinSprite({ skin, hovered = false, className }: SkinSpriteProps) {
  const { frames, fps, playback } = skin;
  const [state, setState] = useState<{ index: number; direction: 1 | -1 }>({
    index: 0,
    direction: 1,
  });
  const visible = usePageVisible();
  // 减少动态效果时只显示第一帧；CSS 附加动效另在 global.css 里关闭。
  const playing =
    visible &&
    !prefersReducedMotion() &&
    frames.length > 1 &&
    playback !== "still" &&
    (playback !== "hover" || hovered);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(
      () => setState((s) => nextFrame(s.index, frames.length, playback, s.direction)),
      Math.round(1000 / fps),
    );
    return () => window.clearInterval(id);
  }, [playing, frames.length, fps, playback]);

  // 不在播放时固定显示第一帧；播放中下标对帧数取模，防止删帧后越界。
  const src = frames[playing ? state.index % frames.length : 0];
  if (src === undefined) return null;
  return (
    <img
      src={src}
      role="presentation"
      aria-hidden="true"
      draggable={false}
      className={cx(
        "nv-skin h-full max-h-full w-auto object-contain",
        skin.pixel && "nv-skin-pixel",
        visible && skin.motion !== "none" && `nv-skin-${skin.motion}`,
        className,
      )}
    />
  );
}
