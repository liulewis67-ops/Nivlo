/** 输入框中一次按键对应的动作。 */
export type KeyAction = "submit" | "cancel" | "none";

/** 一次按键的相关信息。 */
export type KeyInput = {
  /** `KeyboardEvent.key`。 */
  key: string;
  /** 是否处于输入法组合（IME）过程中：此时的 Enter 是在确认候选词，不是提交。 */
  isComposing: boolean;
  /** 输入框当前的文本。 */
  title: string;
};

/**
 * 规范化用户输入的标题：去除首尾空白。
 *
 * 后端会再次校验（标题长度等规则只在后端实现，前端不复制业务规则）；
 * 这里只用来判断"是不是空的"，避免提交一个必然被拒绝的请求。
 *
 * @param raw 输入框里的原始文本。
 * @returns 去除首尾空白后的文本。
 */
export function normalizeTitle(raw: string): string {
  return raw.trim();
}

/**
 * 是否可以提交：规范化后的标题非空（产品文档 §6.1：空标题不允许提交）。
 *
 * @param raw 输入框里的原始文本。
 * @returns 可以提交时为 `true`。
 */
export function canSubmit(raw: string): boolean {
  return normalizeTitle(raw).length > 0;
}

/**
 * 把一次按键翻译为动作：Enter 提交、Esc 取消。
 *
 * 中文用户用拼音输入法时，Enter 用来把拼音上屏；这时必须忽略，否则会提交一个半成品标题。
 * 纯逻辑，便于单元测试。
 *
 * @param input 按键信息。
 * @returns 要执行的动作；标题为空时 Enter 返回 `none`（不允许提交空标题）。
 */
export function resolveKey(input: KeyInput): KeyAction {
  if (input.isComposing) return "none";
  if (input.key === "Escape") return "cancel";
  if (input.key === "Enter") return canSubmit(input.title) ? "submit" : "none";
  return "none";
}
