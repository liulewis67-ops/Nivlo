import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Switch } from "@/components";
import { ShortcutSetting } from "@/features/shortcut";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import type { AppSettingsDto, LaterRuleDto, WeekStartDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";
import { useThemeStore } from "@/stores/theme-store";
import type { ThemePreference } from "@/stores/theme-store";

/** 「稍后」规则选项，按展示顺序。 */
const LATER_RULES: LaterRuleDto[] = ["nextMonday", "inThreeDays", "inOneWeek"];

/** 一周起始日选项，按展示顺序。 */
const WEEK_STARTS: WeekStartDto[] = ["monday", "sunday"];

/** 主题偏好选项，按展示顺序。 */
const THEMES: ThemePreference[] = ["system", "light", "dark"];

/** [`Section`] 的 Props。 */
type SectionProps = {
  /** 分组标题。 */
  title: string;
  /** 分组里的设置行。 */
  children: ReactNode;
};

/**
 * 设置分组：一个标题加一张卡片，卡片里的设置行之间用细线分隔。
 *
 * @param props 标题与内容。
 * @returns 分组元素。
 */
function Section({ title, children }: SectionProps) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-semibold tracking-wide text-muted">{title}</h2>
      <div className="divide-y divide-border rounded-lg border border-border bg-surface">
        {children}
      </div>
    </section>
  );
}

/** [`Row`] 的 Props。 */
type RowProps = {
  /** 设置名。 */
  label: string;
  /** 一句说明。 */
  hint: string;
  /** 右侧的控件。 */
  children: ReactNode;
};

/**
 * 一行设置：左边名称与说明，右边控件。
 *
 * @param props 名称、说明与控件。
 * @returns 设置行。
 */
function Row({ label, hint, children }: RowProps) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * 设置页（实施计划 3.5）：开机自启、悬浮窗置顶、全局快捷键、语言、主题、「稍后」的定义。
 *
 * * 修改立即生效并保存，不需要「保存」按钮；开关与选项先按新值显示（乐观更新），
 *   后端拒绝时（如系统不允许改启动项）回滚并提示原因；
 * * 主题与语言只是显示偏好，保存在本机界面里；
 * * 全局快捷键沿用侧栏里的录入组件。
 *
 * @returns 设置页面。
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = queryKeys.appSettings();
  const settings = useQuery({
    queryKey: key,
    queryFn: () => ipc.getAppSettings(),
    staleTime: Infinity,
  });
  const theme = useThemeStore((state) => state.preference);
  const setTheme = useThemeStore((state) => state.setPreference);

  /**
   * 乐观地改一项设置：先更新缓存，失败时回滚并提示，最后以后端的真实状态校准。
   *
   * @param patch 要改的字段。
   * @param apply 实际的 IPC 调用。
   */
  const change = useMutation({
    mutationFn: async ({
      apply,
    }: {
      patch: Partial<AppSettingsDto>;
      apply: () => Promise<unknown>;
    }) => apply(),
    onMutate: async ({ patch }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<AppSettingsDto>(key);
      if (before !== undefined) queryClient.setQueryData(key, { ...before, ...patch });
      return { before };
    },
    onError: (error, _variables, context) => {
      if (context?.before !== undefined) queryClient.setQueryData(key, context.before);
      reportError(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const current = settings.data;
  return (
    <div className="h-full overflow-y-auto">
      <div
        role="region"
        aria-label={t("settings.label")}
        className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-8"
      >
        <h1 className="text-2xl font-semibold text-text">{t("settings.title")}</h1>
        <Section title={t("settings.section.general")}>
          <Row label={t("settings.autostart.label")} hint={t("settings.autostart.hint")}>
            <Switch
              label={t("settings.autostart.label")}
              checked={current?.autostart ?? false}
              disabled={current === undefined}
              onCheckedChange={(enabled) =>
                change.mutate({
                  patch: { autostart: enabled },
                  apply: () => ipc.setAutostart(enabled),
                })
              }
            />
          </Row>
          <Row label={t("settings.language.label")} hint={t("settings.language.hint")}>
            <select
              aria-label={t("settings.language.label")}
              value="zh-CN"
              onChange={() => undefined}
              className="h-9 rounded-md border border-border bg-bg px-2 text-sm text-text"
            >
              <option value="zh-CN">{t("settings.language.zhCN")}</option>
            </select>
          </Row>
          <Row label={t("settings.theme.label")} hint={t("settings.theme.hint")}>
            <div
              role="group"
              aria-label={t("settings.theme.label")}
              className="flex rounded-md border border-border bg-bg p-0.5"
            >
              {THEMES.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={theme === option}
                  onClick={() => setTheme(option)}
                  className={cx(
                    "h-7 rounded-sm px-3 text-xs transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
                    theme === option
                      ? "bg-primary font-medium text-primary-contrast"
                      : "text-muted hover:bg-surface-hover hover:text-text",
                  )}
                >
                  {t(`theme.${option}`)}
                </button>
              ))}
            </div>
          </Row>
        </Section>
        <Section title={t("settings.section.floating")}>
          <Row label={t("settings.alwaysOnTop.label")} hint={t("settings.alwaysOnTop.hint")}>
            <Switch
              label={t("settings.alwaysOnTop.label")}
              checked={current?.floatingAlwaysOnTop ?? true}
              disabled={current === undefined}
              onCheckedChange={(enabled) =>
                change.mutate({
                  patch: { floatingAlwaysOnTop: enabled },
                  apply: () => ipc.setFloatingAlwaysOnTop(enabled),
                })
              }
            />
          </Row>
          <Row label={t("settings.shortcut.label")} hint={t("settings.shortcut.hint")}>
            <ShortcutSetting />
          </Row>
        </Section>
        <Section title={t("settings.section.notifications")}>
          <Row
            label={t("settings.pauseNotifications.label")}
            hint={t("settings.pauseNotifications.hint")}
          >
            <Switch
              label={t("settings.pauseNotifications.label")}
              checked={current?.notificationsPaused ?? false}
              disabled={current === undefined}
              onCheckedChange={(paused) =>
                change.mutate({
                  patch: { notificationsPaused: paused },
                  apply: () => ipc.setNotificationsPaused(paused),
                })
              }
            />
          </Row>
        </Section>
        <Section title={t("settings.onboarding.label")}>
          <Row label={t("settings.onboarding.label")} hint={t("settings.onboarding.hint")}>
            <Button
              size="sm"
              disabled={current === undefined}
              onClick={() =>
                change.mutate({
                  patch: { onboardingCompleted: false },
                  apply: () => ipc.setOnboardingCompleted(false),
                })
              }
            >
              {t("settings.onboarding.replay")}
            </Button>
          </Row>
        </Section>
        <Section title={t("settings.section.schedule")}>
          <Row label={t("settings.later.label")} hint={t("settings.later.hint")}>
            <div
              role="radiogroup"
              aria-label={t("settings.later.label")}
              className="flex rounded-md border border-border bg-bg p-0.5"
            >
              {LATER_RULES.map((rule) => (
                <button
                  key={rule}
                  type="button"
                  role="radio"
                  aria-checked={current?.laterRule === rule}
                  disabled={current === undefined}
                  onClick={() =>
                    change.mutate({
                      patch: { laterRule: rule },
                      apply: () => ipc.setLaterRule(rule),
                    })
                  }
                  className={cx(
                    "h-7 rounded-sm px-3 text-xs transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
                    current?.laterRule === rule
                      ? "bg-primary font-medium text-primary-contrast"
                      : "text-muted hover:bg-surface-hover hover:text-text",
                  )}
                >
                  {t(`settings.later.${rule}`)}
                </button>
              ))}
            </div>
          </Row>
          <Row label={t("settings.weekStart.label")} hint={t("settings.weekStart.hint")}>
            <div
              role="radiogroup"
              aria-label={t("settings.weekStart.label")}
              className="flex rounded-md border border-border bg-bg p-0.5"
            >
              {WEEK_STARTS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={current?.weekStart === option}
                  disabled={current === undefined}
                  onClick={() =>
                    change.mutate({
                      patch: { weekStart: option },
                      apply: () => ipc.setWeekStart(option),
                    })
                  }
                  className={cx(
                    "h-7 rounded-sm px-3 text-xs transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
                    current?.weekStart === option
                      ? "bg-primary font-medium text-primary-contrast"
                      : "text-muted hover:bg-surface-hover hover:text-text",
                  )}
                >
                  {t(`settings.weekStart.${option}`)}
                </button>
              ))}
            </div>
          </Row>
        </Section>
        <Section title={t("settings.section.data")}>
          <Row label={t("settings.diagnostics.label")} hint={t("settings.diagnostics.hint")}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                ipc
                  .exportDiagnostics()
                  .then((path) =>
                    useToastStore
                      .getState()
                      .push("success", t("settings.diagnostics.done", { path })),
                  )
                  .catch(reportError);
              }}
            >
              {t("settings.diagnostics.action")}
            </Button>
          </Row>
        </Section>
      </div>
    </div>
  );
}
