import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-message";
import { AppError, UNKNOWN_ERROR_CODE, toAppError } from "./errors";

describe("toAppError", () => {
  it("保留后端错误结构中的 code 与 action", () => {
    const error = toAppError({
      code: "STORAGE_UNAVAILABLE",
      message: "db down",
      action: "OPEN_DIAGNOSTICS",
    });
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("STORAGE_UNAVAILABLE");
    expect(error.action).toBe("OPEN_DIAGNOSTICS");
  });

  it("原样返回已有的 AppError", () => {
    const original = new AppError("ITEM_NOT_FOUND", "missing");
    expect(toAppError(original)).toBe(original);
  });

  it("把普通 Error 与未知值规范化为 UNKNOWN", () => {
    expect(toAppError(new Error("boom")).code).toBe(UNKNOWN_ERROR_CODE);
    expect(toAppError("oops").message).toBe("oops");
    expect(toAppError(null).code).toBe(UNKNOWN_ERROR_CODE);
  });
});

describe("errorMessage", () => {
  it("按错误码返回 i18n 文案，而不是后端的英文 message", () => {
    const message = errorMessage(new AppError("ITEM_TITLE_EMPTY", "title must not be empty"));
    expect(message).toBe("标题不能为空。");
  });

  it("未登记的错误码回退到通用文案", () => {
    expect(errorMessage(new AppError("SOMETHING_NEW", "x"))).toBe("出了点问题，请稍后重试。");
  });
});
