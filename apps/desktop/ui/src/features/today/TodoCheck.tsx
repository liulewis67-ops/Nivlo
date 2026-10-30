import { cx } from "@/lib/cx";

/** [`TodoCheck`] 的 Props。 */
export type TodoCheckProps = {
  /** 是否已完成。 */
  checked: boolean;
  /** 可访问名称（含标题）。 */
  label: string;
  /** 点击时调用。 */
  onToggle: () => void;
  /** 形状：待办是圆角方形，提示是圆形（一眼分清哪些是提示）。 */
  shape?: "square" | "round";
};

/**
 * 待办前面的圆角方形勾选框（提示用圆形）：整个按钮都是点击目标，勾选时播放一个轻微的弹跳。
 *
 * @param props 状态、名称与回调。
 * @returns 勾选按钮。
 */
export function TodoCheck({ checked, label, onToggle, shape = "square" }: TodoCheckProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cx(
        "flex size-4 shrink-0 items-center justify-center border",
        shape === "round" ? "rounded-full" : "rounded-sm",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        checked
          ? "border-primary bg-primary text-primary-contrast"
          : "border-border bg-surface hover:border-primary",
      )}
    >
      <svg
        viewBox="0 0 16 16"
        className={cx("size-3", checked ? "opacity-100" : "opacity-0")}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
    </button>
  );
}
