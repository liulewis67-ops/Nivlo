import type { BadgeShape } from "@/stores/appearance-store";

/** 收起态徽标的 logical 尺寸（px）。 */
export type BadgeSize = { width: number; height: number };

/**
 * 默认（胶囊）徽标的尺寸。必须与 Rust 的 `COLLAPSED_WIDTH_LOGICAL_PX` / `COLLAPSED_HEIGHT_LOGICAL_PX`
 * 一致：窗口按它创建，默认形状启动时不需要再告诉后端一次。
 */
export const DEFAULT_BADGE_SIZE: BadgeSize = { width: 64, height: 32 };

/** 每种形状的徽标尺寸：窗口和形状一样大，形状以外没有透明的"死角"。 */
const SHAPE_SIZES: Record<BadgeShape, BadgeSize> = {
  pill: DEFAULT_BADGE_SIZE,
  circle: { width: 36, height: 36 },
  dot: { width: 28, height: 28 },
};

/** 自定义皮肤的徽标尺寸：给图片留出空间。 */
const SKIN_SIZE: BadgeSize = { width: 88, height: 40 };

/**
 * 当前外观下收起态徽标的尺寸。
 *
 * @param shape 徽标形状。
 * @param hasSkin 是否使用自定义皮肤（皮肤优先于形状）。
 * @returns logical 尺寸。
 */
export function badgeSize(shape: BadgeShape, hasSkin: boolean): BadgeSize {
  return hasSkin ? SKIN_SIZE : SHAPE_SIZES[shape];
}
