/**
 * 拼接 CSS 类名，忽略假值。
 *
 * @param classes 类名片段；`false`、`null`、`undefined` 与空串会被丢弃。
 * @returns 以空格连接的类名字符串。
 * @example
 * cx("px-2", isActive && "bg-primary") // => "px-2 bg-primary"（isActive 为真时）
 */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
