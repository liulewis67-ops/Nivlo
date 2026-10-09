import type { ComponentProps } from "react";
import { cx } from "@/lib/cx";

/** 输入类控件共用的外观样式。 */
const FIELD_CLASSES = cx(
  "w-full rounded-md border border-border bg-surface px-3 text-sm text-text",
  "placeholder:text-muted",
  "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
  "focus-visible:border-focus disabled:cursor-not-allowed disabled:opacity-50",
);

/** [`Input`] 的 Props：原生 `<input>` 属性。可访问名称需通过 `aria-label` 或关联 `<label>` 提供。 */
export type InputProps = ComponentProps<"input">;

/**
 * 单行文本输入框。
 *
 * @param props 原生输入框属性。
 * @returns 输入框元素。
 */
export function Input({ className, ...rest }: InputProps) {
  return <input className={cx(FIELD_CLASSES, "h-9", className)} {...rest} />;
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
  return <textarea className={cx(FIELD_CLASSES, "min-h-20 py-2", className)} {...rest} />;
}
