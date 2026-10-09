import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Menu } from "@/components";
import type { MenuItemSpec } from "@/components";
import type { ItemTypeDto } from "@/lib/ipc";
import { useThemeStore } from "@/stores/theme-store";
import type { ThemePreference } from "@/stores/theme-store";
import { useCreateItemMutation, useItemsQuery } from "./api";

/** 可创建的 Item 类型，按展示顺序排列。 */
const ITEM_TYPES: ItemTypeDto[] = ["todo", "note", "tip"];

/** 主题偏好选项，按展示顺序排列。 */
const THEME_OPTIONS: ThemePreference[] = ["system", "light", "dark"];

/**
 * 开发控制台：Phase 0 的 IPC 演示页（里程碑 M0）。
 *
 * 可以创建并列出 Item，用于验证 UI → IPC → Application → Domain → SQLite 整条链路，
 * 同时展示基础控件与主题切换。Phase 1 起被真正的 Today 视图取代，仅在主窗口显示。
 *
 * @returns 控制台页面。
 */
export function DevConsole() {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [itemType, setItemType] = useState<ItemTypeDto>("todo");
  const items = useItemsQuery();
  const createItem = useCreateItemMutation();
  const themePreference = useThemeStore((state) => state.preference);
  const setThemePreference = useThemeStore((state) => state.setPreference);

  const themeItems: MenuItemSpec[] = THEME_OPTIONS.map((option) => ({
    id: option,
    label: t(`theme.${option}`),
    isDisabled: option === themePreference,
    onSelect: () => setThemePreference(option),
  }));

  /**
   * 提交创建表单。
   *
   * 成功后清空输入；失败时保留输入，错误由全局 Toast 展示。
   *
   * @param event 表单提交事件。
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    createItem.mutate(
      {
        itemType,
        title,
        content: null,
        contentFormat: null,
        priority: null,
        scheduled: null,
        due: null,
        reminderAt: null,
        projectId: null,
      },
      { onSuccess: () => setTitle("") },
    );
  }

  return (
    <main className="mx-auto flex h-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t("dev.title")}</h1>
          <p className="text-sm text-muted">{t("dev.subtitle")}</p>
        </div>
        <Menu trigger={<Button size="sm">{t("theme.label")}</Button>} items={themeItems} />
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex gap-2" role="radiogroup" aria-label={t("dev.form.typeLabel")}>
          {ITEM_TYPES.map((type) => (
            <Button
              key={type}
              size="sm"
              role="radio"
              aria-checked={itemType === type}
              variant={itemType === type ? "primary" : "secondary"}
              onClick={() => setItemType(type)}
            >
              {t(`dev.type.${type}`)}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            aria-label={t("dev.form.titleLabel")}
            placeholder={t("dev.form.titlePlaceholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={createItem.isPending}>
            {t("dev.form.submit")}
          </Button>
        </div>
      </form>

      <section aria-labelledby="dev-list-heading" className="flex min-h-0 flex-1 flex-col gap-2">
        <h2 id="dev-list-heading" className="text-sm font-medium text-muted">
          {t("dev.list.heading")}
        </h2>
        {items.data !== undefined && items.data.length === 0 ? (
          <p className="text-sm text-muted">{t("dev.list.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1 overflow-y-auto">
            {items.data?.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
              >
                <span className="rounded-sm bg-surface-hover px-1.5 py-0.5 text-xs text-muted">
                  {t(`dev.type.${item.itemType}`)}
                </span>
                <span className="flex-1 truncate">{item.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
