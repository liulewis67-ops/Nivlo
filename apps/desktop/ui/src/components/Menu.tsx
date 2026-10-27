import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { createContext, useContext } from "react";
import type { ReactElement } from "react";
import { cx } from "@/lib/cx";

/**
 * 菜单是否模态（缺省是）。模态菜单打开时会给页面其余部分加上 `pointer-events: none`，
 * 指针随之被认为离开了原来所在的元素；悬浮窗靠指针离开来收起面板，所以它把菜单设为非模态
 * （点菜单外照样关闭，只是不屏蔽页面其余部分的指针事件）。`Menu` 与 `ContextMenu` 都遵循它。
 */
export const MenuModalContext = createContext(true);

/** 菜单项的描述。 */
export type MenuItemSpec = {
  /** 稳定的标识，用作 React key。 */
  id: string;
  /** 已翻译的展示文案。 */
  label: string;
  /** 选中时的回调。 */
  onSelect: () => void;
  /** 危险操作（如删除），以警示色显示。 */
  isDanger?: boolean;
  /** 是否禁用。 */
  isDisabled?: boolean;
};

/** [`Menu`] 的 Props。 */
export type MenuProps = {
  /** 触发菜单的元素（通常是一个 `Button`），需要能接收 ref 与事件。 */
  trigger: ReactElement;
  /** 菜单项。 */
  items: MenuItemSpec[];
};

/**
 * 下拉菜单。
 *
 * 基于 Radix 的无样式原语获得键盘导航、焦点管理与读屏支持，外观由 Design Token 控制
 * （前端规范 §2.2：只允许 headless 原语）。
 *
 * @param props 触发元素与菜单项。
 * @returns 菜单元素。
 */
export function Menu({ trigger, items }: MenuProps) {
  const modal = useContext(MenuModalContext);
  return (
    <DropdownMenu.Root modal={modal}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={cx(
            "z-(--nv-z-menu) min-w-36 rounded-md border border-border bg-surface p-1 shadow-md",
          )}
        >
          {items.map((item) => (
            <DropdownMenu.Item
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
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
