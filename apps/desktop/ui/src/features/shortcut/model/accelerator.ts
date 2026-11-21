/** 只有修饰键时 `event.key` 的取值：这些按下本身不构成快捷键。 */
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"]);

/** 键盘事件里与快捷键有关的部分，便于测试时构造。 */
export type KeyEventLike = {
  /** 物理按键，如 `KeyQ`、`Digit5`、`F12`、`Space`。 */
  code: string;
  /** 逻辑按键，如 `q`、`Control`。 */
  key: string;
  /** Ctrl 是否按下。 */
  ctrlKey: boolean;
  /** Alt 是否按下。 */
  altKey: boolean;
  /** Shift 是否按下。 */
  shiftKey: boolean;
  /** Win / Command 是否按下。 */
  metaKey: boolean;
};

/**
 * 物理按键 → 快捷键里的主键名（与后端 `Accelerator` 的文本一致）。
 *
 * 用物理按键（`code`）而不是 `key`：Shift 会改变 `key`（`q` → `Q`、`5` → `%`），
 * 也与键盘布局和输入法无关。
 *
 * @param code `KeyboardEvent.code`。
 * @returns 主键名；不支持的按键返回 `null`。
 */
function mainKeyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return digit[1] ?? null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  return named[code] ?? null;
}

/** 录入的结果：一个完整的快捷键、尚未完成（只按了修饰键）或不可用。 */
export type CaptureResult =
  | { kind: "accelerator"; text: string }
  | { kind: "incomplete" }
  | { kind: "unusable"; reason: "noModifier" | "unsupportedKey" };

/**
 * 把一次按键变成快捷键文本，用于「按下新的快捷键」的录入框。
 *
 * 全局快捷键必须至少带一个修饰键：单独的字母、空格会吞掉用户正常的输入。
 *
 * @param event 按键事件。
 * @returns 录入结果。
 */
export function captureAccelerator(event: KeyEventLike): CaptureResult {
  if (MODIFIER_KEYS.has(event.key)) return { kind: "incomplete" };
  const key = mainKeyName(event.code);
  if (key === null) return { kind: "unusable", reason: "unsupportedKey" };
  const modifiers = [
    event.ctrlKey ? "Ctrl" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
    event.metaKey ? "Win" : null,
  ].filter((name): name is string => name !== null);
  if (modifiers.length === 0) return { kind: "unusable", reason: "noModifier" };
  return { kind: "accelerator", text: [...modifiers, key].join("+") };
}
