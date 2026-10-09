/** 后端 IPC 错误的结构（与生成的 `IpcError` 同形），见后端规范 §5.1。 */
export type IpcErrorShape = {
  /** 稳定的大写错误码，如 `ITEM_NOT_FOUND`。 */
  code: string;
  /** 面向开发者的说明，只用于日志，禁止直接展示给用户。 */
  message: string;
  /** 可恢复错误附带的 UI 动作，如 `OPEN_DIAGNOSTICS`。 */
  action: string | null;
};

/**
 * 应用错误：后端返回的 `{ code, message, action }` 在前端的表示。
 *
 * UI 根据 `code` 选择展示的文案（i18n key 为 `error.<code>`），根据 `action` 渲染操作按钮。
 */
export class AppError extends Error {
  /** 稳定的错误码。 */
  readonly code: string;

  /** 附带的 UI 动作，没有时为 `null`。 */
  readonly action: string | null;

  /**
   * 创建应用错误。
   *
   * @param code 稳定的错误码。
   * @param message 面向开发者的说明。
   * @param action 附带的 UI 动作。
   */
  constructor(code: string, message: string, action: string | null = null) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.action = action;
  }
}

/** 前端自身产生的、没有后端错误码的未知错误。 */
export const UNKNOWN_ERROR_CODE = "UNKNOWN";

/**
 * 判断一个值是否具有后端 IPC 错误的结构。
 *
 * @param value 待检查的值。
 * @returns 是 `{ code: string, message: string, action }` 结构时为 `true`。
 */
function isIpcErrorShape(value: unknown): value is IpcErrorShape {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["code"] === "string" && typeof record["message"] === "string";
}

/**
 * 把任意抛出的值规范化为 [`AppError`]。
 *
 * @param error `catch` 到的值：`AppError`、后端错误结构、普通 `Error` 或其他。
 * @returns 带稳定错误码的 `AppError`；无法识别时错误码为 `UNKNOWN`。
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isIpcErrorShape(error)) {
    const action = typeof error.action === "string" ? error.action : null;
    return new AppError(error.code, error.message, action);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(UNKNOWN_ERROR_CODE, message);
}
