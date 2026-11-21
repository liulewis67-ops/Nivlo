import { errorMessage } from "./error-message";
import { toAppError } from "./errors";
import { useToastStore } from "@/stores/toast-store";

/**
 * 把任意错误统一显示为错误 Toast，并把详细信息写入控制台日志。
 *
 * 文案来自 i18n（以错误码为 key），后端 `message` 只进日志，不展示给用户（前端规范 §6.3）。
 *
 * @param error 抛出的任意错误。
 */
export function reportError(error: unknown): void {
  const appError = toAppError(error);
  console.error(`[${appError.code}] ${appError.message}`);
  useToastStore.getState().push("error", errorMessage(appError));
}
