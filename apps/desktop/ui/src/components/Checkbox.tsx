import { cx } from "@/lib/cx";

/** [`Checkbox`] 的 Props。 */
export type CheckboxProps = {
  /** 是否选中。 */
  checked: boolean;
  /** 选中状态变化时的回调，参数为新的选中状态。 */
  onCheckedChange: (checked: boolean) => void;
  /** 复选框旁显示的文案，同时作为可访问名称。 */
  label: string;
  /** 是否禁用。 */
  disabled?: boolean;
};

/**
 * 自绘复选框。
 *
 * 原生 `<input type="checkbox">` 仅用于键盘与读屏支持（视觉上隐藏），
 * 外观由 Token 驱动的方框绘制，保证跨 WebView 一致。
 *
 * @param props 选中状态、回调与文案。
 * @returns 复选框元素。
 */
export function Checkbox({ checked, onCheckedChange, label, disabled = false }: CheckboxProps) {
  return (
    <label
      className={cx(
        "inline-flex cursor-pointer items-center gap-2 text-sm text-text",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        className={cx(
          "flex size-4 items-center justify-center rounded-sm border border-border bg-surface",
          "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
          "peer-checked:border-primary peer-checked:bg-primary",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus",
        )}
      >
        <svg
          viewBox="0 0 16 16"
          className={cx("size-3 text-primary-contrast", checked ? "opacity-100" : "opacity-0")}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 8.5l3.2 3.2L13 4.8" />
        </svg>
      </span>
      {label}
    </label>
  );
}
