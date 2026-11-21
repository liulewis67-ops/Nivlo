import { initI18n } from "@/i18n";
import type { AppError } from "./errors";

/**
 * 把 [`AppError`] 转换为面向用户的文案。
 *
 * 文案以错误码为 key（`error.<CODE>`）；没有登记的错误码回退到 `error.UNKNOWN`。
 * 后端的 `message` 只用于日志，绝不展示给用户（前端规范 §6.3）。
 *
 * @param error 应用错误。
 * @returns 当前语言下的用户文案。
 */
export function errorMessage(error: AppError): string {
  const i18n = initI18n();
  const key = `error.${error.code}`;
  return i18n.exists(key) ? i18n.t(key) : i18n.t("error.UNKNOWN");
}
