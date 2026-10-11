import { useEffect, useState } from "react";
import { Button } from "./Button";
import type { ButtonProps } from "./Button";

/** 第一次点击之后，多久不确认就自动取消（毫秒）。 */
export const CONFIRM_WINDOW_MS = 3000;

/** [`ConfirmButton`] 的 Props。 */
export type ConfirmButtonProps = Omit<ButtonProps, "onClick" | "children"> & {
  /** 平时的文案。 */
  label: string;
  /** 第一次点击之后的文案（提示再点一次确认）。 */
  confirmLabel: string;
  /** 确认之后调用。 */
  onConfirm: () => void;
};

/**
 * 需要二次确认的按钮：第一次点击只是「武装」（文案变成确认提示、警示色），
 * [`CONFIRM_WINDOW_MS`] 内再点一次才真正执行；超时、失焦或按 Esc 都会取消。
 *
 * 用于不可恢复的操作（永久删除、清空回收站），比弹模态对话框打断更少，又不会手滑误删。
 *
 * @param props 文案与回调。
 * @returns 按钮。
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, ...rest }: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      {...rest}
      variant={armed ? "danger" : (rest.variant ?? "ghost")}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
      onBlur={() => setArmed(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && armed) {
          event.stopPropagation();
          setArmed(false);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}
