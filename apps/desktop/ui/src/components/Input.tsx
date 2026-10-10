import type { ComponentProps } from "react";
import { cx } from "@/lib/cx";

/** 输入类控件共用的外观样式。 */
const FIELD_CLASSES = cx(
  "rounded-md border border-border bg-surface px-3 text-sm text-text",
  "placeholder:text-muted",
  "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
  "focus-visible:border-focus disabled:cursor-not-allowed disabled:opacity-50",
);

/**
 * `className` 里是否已经有以 `prefix` 开头的工具类（如 `w-24`、`h-8`）。
 *
 * @param className 调用方传入的类名。
 * @param prefix 工具类前缀。
 * @returns 已有时为 `true`。
 */
function hasUtility(className: string, prefix: string): boolean {
  return className.split(" ").some((name) => name.startsWith(prefix));
}

/** [`Input`] 的 Props：原生 `<input>` 属性。可访问名称需通过 `aria-label` 或关联 `<label>` 提供。 */
export type InputProps = ComponentProps<"input">;

/**
 * 默认宽度撑满、高度 `h-9`；调用方通过 `className` 指定了宽度（`w-…`）或高度（`h-…`）时，
 * 以调用方为准——同时带两个冲突的工具类时，谁生效取决于样式表顺序，所以这里不叠加默认值。
 *
 * 单行文本输入框。
 *
 * @param props 原生输入框属性。
 * @returns 输入框元素。
 */
export function Input({ className, ...rest }: InputProps) {
  const custom = className ?? "";
  return (
    <input
      className={cx(
        FIELD_CLASSES,
        !hasUtility(custom, "w-") && "w-full",
        !hasUtility(custom, "h-") && "h-9",
        className,
      )}
      {...rest}
    />
  );
}

/** [`Textarea`] 的 Props：原生 `<textarea>` 属性。 */
export type TextareaProps = ComponentProps<"textarea">;

/**
 * 多行文本输入框。
 *
 * @param props 原生文本域属性。
 * @returns 文本域元素。
 */
export function Textarea({ className, ...rest }: TextareaProps) {
  const custom = className ?? "";
  return (
    <textarea
      className={cx(
        FIELD_CLASSES,
        !hasUtility(custom, "w-") && "w-full",
        "min-h-20 py-2",
        className,
      )}
      {...rest}
    />
  );
}
