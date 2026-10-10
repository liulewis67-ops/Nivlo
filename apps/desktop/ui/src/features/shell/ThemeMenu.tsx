import { useTranslation } from "react-i18next";
import { Button, Menu } from "@/components";
import type { MenuItemSpec } from "@/components";
import { useThemeStore } from "@/stores/theme-store";
import type { ThemePreference } from "@/stores/theme-store";

/** 主题偏好选项，按展示顺序排列。 */
const THEME_OPTIONS: ThemePreference[] = ["system", "light", "dark"];

/**
 * 主题切换菜单：按钮上显示当前偏好，菜单里选择跟随系统 / 浅色 / 深色。
 *
 * @returns 菜单元素。
 */
export function ThemeMenu() {
  const { t } = useTranslation();
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  const items: MenuItemSpec[] = THEME_OPTIONS.map((option) => ({
    id: option,
    label: t(`theme.${option}`),
    isDisabled: option === preference,
    onSelect: () => setPreference(option),
  }));
  return (
    <Menu
      items={items}
      trigger={
        <Button variant="ghost" size="sm" className="w-full justify-start">
          {t("theme.current", { preference: t(`theme.${preference}`) })}
        </Button>
      }
    />
  );
}
