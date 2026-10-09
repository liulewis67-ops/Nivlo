/**
 * 判断字符串是否为空白（仅含空白字符或为空）。
 *
 * 作为测试管线的最小示例，后续被真实工具函数替换。
 *
 * @param value - 待检查的字符串。
 * @returns 为空白时返回 `true`。
 */
export function isBlank(value: string): boolean {
  return value.trim().length === 0;
}
