import * as RadixContextMenu from "@radix-ui/react-context-menu";
import { useContext } from "react";
import type { ReactElement } from "react";
import { cx } from "@/lib/cx";
import { MenuModalContext } from "./Menu";
import type { MenuItemSpec } from "./Menu";

/** [`ContextMenu`] 的 Props。 */
export type ContextMenuProps = {
  /** 响应右键的元素，需要能接收 ref 与事件。 */
  children: ReactElement;
  /** 菜单项；与 [`Menu`](./Menu.tsx) 共用同一个描述，方便同一份菜单既能下拉也能右键。 */
  items: MenuItemSpec[];
};

/**
 * 右键菜单。
 *
 * 与 `Menu` 一样基于 Radix 的无样式原语（键盘导航、焦点管理、读屏），外观由 Design Token 控制。
 *
 * @param props 目标元素与菜单项。
 * @returns 带右键菜单的元素。
 */
export function ContextMenu({ children, items }: ContextMenuProps) {
  const modal = useContext(MenuModalContext);
  return (
    <RadixContextMenu.Root modal={modal}>
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content
          className={cx(
            "z-(--nv-z-menu) min-w-36 rounded-md border border-border bg-surface p-1 shadow-md",
          )}
        >
          {items.map((item) => (
            <RadixContextMenu.Item
              key={item.id}
              disabled={item.isDisabled ?? false}
              onSelect={item.onSelect}
              className={cx(
                "flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none",
                "data-[highlighted]:bg-surface-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
                item.isDanger === true ? "text-danger" : "text-text",
              )}
            >
              {item.label}
            </RadixContextMenu.Item>
          ))}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}
