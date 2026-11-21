import { cx } from "@/lib/cx";

/** [`Switch`] 的 Props。 */
export type SwitchProps = {
  /** 是否开启。 */
  checked: boolean;
  /** 状态变化时的回调，参数为新的状态。 */
  onCheckedChange: (checked: boolean) => void;
  /** 可访问名称（读屏用，视觉上不显示）。 */
  label: string;
  /** 是否禁用。 */
  disabled?: boolean;
};

/**
 * 开关：`role="switch"`，空格 / 回车切换，滑块只用 transform 做动画。
 *
 * 开启态用主色，关闭态用边框色，对比度在浅色 / 深色主题下都足够。
 *
 * @param props 状态、回调与名称。
 * @returns 开关按钮。
 */
export function Switch({ checked, onCheckedChange, label, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-border",
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "ml-0.5 size-5 rounded-full bg-surface shadow-sm",
          "transition-transform duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
          checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}
