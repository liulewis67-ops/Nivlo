import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

/** Tooltip 出现前的延迟（毫秒），避免鼠标划过时闪烁。 */
const TOOLTIP_DELAY_MS = 400;

/** [`TooltipProvider`] 的 Props。 */
export type TooltipProviderProps = {
  /** 需要使用 Tooltip 的子树。 */
  children: ReactNode;
};

/**
 * Tooltip 的全局 Provider，统一延迟配置；放在应用根部一次即可。
 *
 * @param props 子树。
 * @returns Provider 元素。
 */
export function TooltipProvider({ children }: TooltipProviderProps) {
  return <RadixTooltip.Provider delayDuration={TOOLTIP_DELAY_MS}>{children}</RadixTooltip.Provider>;
}

/** [`Tooltip`] 的 Props。 */
export type TooltipProps = {
  /** 已翻译的提示文案。 */
  content: string;
  /** 被提示的元素，需要能接收 ref 与事件。 */
  children: ReactElement;
};

/**
 * 悬停 / 聚焦时显示的提示气泡。
 *
 * @param props 提示文案与被提示的元素。
 * @returns Tooltip 元素。
 */
export function Tooltip({ content, children }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={6}
          className="z-(--nv-z-tooltip) rounded-md border border-border bg-surface px-2 py-1 text-xs text-text shadow-md"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
