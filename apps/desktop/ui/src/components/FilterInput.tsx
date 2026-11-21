import { useEffect, useRef } from "react";
import { cx } from "@/lib/cx";
import { isCommandKey, isDialogOpen } from "@/lib/typing";
import { Input } from "./Input";

/** [`FilterInput`] 的 Props。 */
export type FilterInputProps = {
  /** 当前筛选文字。 */
  value: string;
  /** 文字变化（包括 Esc 清空）时调用。 */
  onValueChange: (value: string) => void;
  /** 可访问名称，同时用作占位文字。 */
  label: string;
  /** 按 ↓ 或 Enter 时调用，把焦点移进列表；返回 `true` 表示处理了（会阻止默认行为）。 */
  onMoveDown?: (() => boolean) | undefined;
  /**
   * 是否响应窗口级的 Ctrl+F（跳到这个框并全选）。传函数时每次按下再判断，
   * 如笔记页在编辑区里时把 Ctrl+F 留给页内查找。
   */
  findShortcut?: boolean | (() => boolean) | undefined;
  /** 额外的类名。 */
  className?: string | undefined;
};

/**
 * 列表上方的筛选框（笔记、收集箱、回收站共用）：
 *
 * * Esc 清空（有内容时，并且不再冒泡，免得同时关掉别的东西）；
 * * ↓ / Enter 交给 `onMoveDown` 把焦点移进列表；
 * * 可选的 Ctrl+F：有对话框打开时不响应。
 *
 * @param props 文字、回调与选项。
 * @returns 搜索框。
 */
export function FilterInput({
  value,
  onValueChange,
  label,
  onMoveDown,
  findShortcut,
  className,
}: FilterInputProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (findShortcut === undefined || findShortcut === false) return undefined;
    /**
     * Ctrl+F 跳到筛选框。
     *
     * @param event 键盘事件。
     */
    function handleFind(event: globalThis.KeyboardEvent): void {
      if (!isCommandKey(event, "f") || isDialogOpen()) return;
      if (typeof findShortcut === "function" && !findShortcut()) return;
      event.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    }
    window.addEventListener("keydown", handleFind);
    return () => window.removeEventListener("keydown", handleFind);
  }, [findShortcut]);

  return (
    <Input
      ref={ref}
      type="search"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && value !== "") {
          event.preventDefault();
          event.stopPropagation();
          onValueChange("");
        } else if (
          (event.key === "ArrowDown" || event.key === "Enter") &&
          // 输入法选字时的 Enter 是确认候选词，不是移进列表。
          !event.nativeEvent.isComposing &&
          onMoveDown?.() === true
        ) {
          event.preventDefault();
        }
      }}
      aria-label={label}
      aria-keyshortcuts={
        findShortcut === undefined || findShortcut === false ? undefined : "Control+F"
      }
      placeholder={label}
      className={cx("h-8", className)}
    />
  );
}
