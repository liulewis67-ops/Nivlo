import type { ComponentProps } from "react";
import { cx } from "@/lib/cx";

/** 按钮的视觉变体。 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** 按钮的尺寸。 */
export type ButtonSize = "sm" | "md";

/** [`Button`] 的 Props，在原生按钮属性之上增加视觉变体与尺寸。 */
export type ButtonProps = ComponentProps<"button"> & {
  /** 视觉变体，默认 `secondary`。 */
  variant?: ButtonVariant;
  /** 尺寸，默认 `md`。 */
  size?: ButtonSize;
};

/** 各变体的样式；只使用 Design Token 工具类，不硬编码色值。 */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-contrast hover:bg-primary-hover border-transparent",
  secondary: "bg-surface text-text border-border hover:bg-surface-hover",
  ghost: "bg-transparent text-text border-transparent hover:bg-surface-hover",
  danger: "bg-danger text-danger-contrast border-transparent hover:opacity-90",
};

/** 各尺寸的样式。 */
const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 px-2 text-xs",
  md: "h-9 px-3 text-sm",
};

/**
 * 通用按钮。
 *
 * 不依赖浏览器默认按钮外观，保证 WebView2 / WKWebView / WebKitGTK 下一致（架构文档 §47）。
 * 默认 `type="button"`，避免在表单里意外提交。
 *
 * @param props 原生按钮属性，外加 `variant` 与 `size`。
 * @returns 按钮元素。
 */
export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    />
  );
}
