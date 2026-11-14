import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, ConfirmButton, Switch, LoadFeedback } from "@/components";
import { isLanguage, setLanguage } from "@/i18n";
import { ShortcutSetting } from "@/features/shortcut";
import { useNavStore } from "@/features/shell";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import type { AppSettingsDto, LaterRuleDto, RestoreStagedDto, WeekStartDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";
import {
  AVATAR_MODES,
  MAX_FPS,
  MIN_FPS,
  MOTIONS,
  PLAYBACKS,
  ROBOTS,
  ROBOT_COLORS,
  ROBOT_FACES,
  useSkinStore,
} from "@/stores/skin-store";
import { RobotAvatar } from "@/features/floating";
import type { Skin } from "@/stores/skin-store";
import { SkinSetting } from "./SkinSetting";
import { useThemeStore } from "@/stores/theme-store";
import type { ThemePreference } from "@/stores/theme-store";
import {
  ACCENTS,
  BADGE_SHAPES,
  CORNERS,
  MAX_OPACITY,
  MIN_OPACITY,
  SURFACES,
  useAppearanceStore,
} from "@/stores/appearance-store";
import { useDisplayStore } from "@/stores/display-store";
import { IntegrationsSetting } from "./IntegrationsSetting";
import { UpdateSetting } from "./UpdateSetting";

/** 「稍后」规则选项，按展示顺序。 */
const LATER_RULES: LaterRuleDto[] = ["nextMonday", "inThreeDays", "inOneWeek"];

/** 一周起始日选项，按展示顺序。 */
const WEEK_STARTS: WeekStartDto[] = ["monday", "sunday"];

/** 导出格式选项，按展示顺序。 */
const EXPORT_FORMATS = ["json", "markdown", "markdownFiles"] as const;

/** 主题偏好选项，按展示顺序。 */
const THEMES: ThemePreference[] = ["system", "light", "dark"];

/** [`Segmented`] 的 Props。 */
type SegmentedProps<T extends string> = {
  label: string;
  value: T;
  options: readonly T[];
  render: (option: T) => string;
  onChange: (option: T) => void;
};

/**
 * 分段选择器：一组互斥按钮。
 *
 * @param props 当前值、选项与回调。
 * @returns 分段控件。
 */
function Segmented<T extends string>({
  label,
  value,
  options,
  render,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex max-w-full flex-wrap rounded-md border border-border bg-bg p-0.5"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cx(
            "h-7 rounded-sm px-3 text-xs transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
            value === option
              ? "bg-primary font-medium text-primary-contrast"
              : "text-muted hover:bg-surface-hover hover:text-text",
          )}
        >
          {render(option)}
        </button>
      ))}
    </div>
  );
}

/** 强调色预设的展示色。 */
const ACCENT_SWATCH: Record<(typeof ACCENTS)[number], string> = {
  blue: "#2563eb",
  violet: "#7c4dff",
  teal: "#0d9488",
  rose: "#e11d48",
  amber: "#d97706",
};

/** 设置分组：锚点 ID 与标题的翻译键，顺序与页面上一致（页首跳转链接与 Ctrl+K 的「设置：…」命令共用）。 */
export const SETTINGS_SECTIONS: readonly (readonly [string, string])[] = [
  ["settings-general", "settings.section.general"],
  ["settings-floating", "settings.section.floating"],
  ["settings-shortcuts", "settings.section.shortcuts"],
  ["settings-appearance", "settings.section.appearance"],
  ["settings-notifications", "settings.section.notifications"],
  ["settings-onboarding", "settings.onboarding.label"],
  ["settings-schedule", "settings.section.schedule"],
  ["settings-integrations", "settings.section.integrations"],
  ["settings-about", "settings.section.about"],
  ["settings-data", "settings.section.data"],
];

/** [`Section`] 的 Props。 */
type SectionProps = {
  /** 分组的锚点 ID（页首的跳转链接用）。 */
  id: string;
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
function Section({ id, title, children }: SectionProps) {
  return (
    <section id={id} aria-label={title} className="flex scroll-mt-4 flex-col gap-2">
      <h2 tabIndex={-1} className="px-1 text-base font-semibold text-text">
        {title}
      </h2>
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
  hint?: string;
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
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3.5">
      <div className="min-w-0 flex-1 basis-52">
        <p className="text-sm font-medium text-text">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      <div className="min-w-0 max-w-full">{children}</div>
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
  const { t, i18n } = useTranslation();
  const [activeSection, setActiveSection] = useState(SETTINGS_SECTIONS[0]?.[0] ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 分组跳转后聚焦真实标题，继续 Tab 就进入该组控件。 */
  function jumpTo(id: string): void {
    const section = document.getElementById(id);
    section?.scrollIntoView({ block: "start" });
    section?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }
  const hideCompleted = useDisplayStore((state) => state.hideCompleted);
  const setHideCompleted = useDisplayStore((state) => state.setHideCompleted);
  const queryClient = useQueryClient();
  const key = queryKeys.appSettings();
  const settings = useQuery({
    queryKey: key,
    queryFn: () => ipc.getAppSettings(),
    staleTime: Infinity,
  });
  const [exportFormat, setExportFormat] = useState<(typeof EXPORT_FORMATS)[number]>("json");
  /** 已暂存、等待重启生效的恢复。 */
  const [staged, setStaged] = useState<RestoreStagedDto | null>(null);
  /** 已暂存「删除所有数据」时，自动备份的路径。 */
  const [resetSafety, setResetSafety] = useState<string | null>(null);
  const appearance = useAppearanceStore((state) => state.appearance);
  const updateAppearance = useAppearanceStore((state) => state.update);
  const resetAppearance = useAppearanceStore((state) => state.reset);
  const skin = useSkinStore((state) => state.skin);
  const saveSkin = useSkinStore((state) => state.update);
  /**
   * 保存外观并在本地写入失败时反馈。
   * @param patch 更改的外观字段。
   */
  function updateSkin(patch: Partial<Skin>): void {
    if (!saveSkin(patch)) {
      useToastStore.getState().push("error", t("settings.companion.saveFailed"));
    }
  }
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

  // Ctrl+K「设置：…」打开时滚到那一组，然后清掉请求（再打开设置页时从头显示）。
  const requestedSection = useNavStore((state) => state.settingsSection);
  useEffect(() => {
    if (requestedSection === null) return;
    jumpTo(requestedSection);
    useNavStore.getState().openSettings(null);
  }, [requestedSection]);

  const current = settings.data;
  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto"
      onFocusCapture={(event) => {
        if (event.target instanceof Element) {
          const id = event.target.closest('section[id^="settings-"]')?.id;
          if (id) setActiveSection(id);
        }
      }}
      onScroll={() => {
        const top = scrollRef.current?.getBoundingClientRect().top ?? 0;
        const reached = SETTINGS_SECTIONS.filter(
          ([id]) =>
            (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= top + 64,
        );
        const latest = reached.at(-1)?.[0];
        if (latest) setActiveSection(latest);
      }}
    >
      <div
        role="region"
        aria-label={t("settings.label")}
        className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6"
      >
        <h1 className="text-lg font-semibold text-text">{t("settings.title")}</h1>
        {/* 设置分组较多：页首列出各组，点一下滚到那里。 */}
        <nav aria-label={t("settings.jump")} className="-mt-3 flex flex-wrap gap-x-3 gap-y-1">
          {SETTINGS_SECTIONS.map(([id, key]) => (
            <button
              key={id}
              type="button"
              aria-current={activeSection === id ? "location" : undefined}
              onClick={() => jumpTo(id)}
              className={cx(
                "min-h-7 rounded px-2 text-left text-sm transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard) hover:text-primary",
                activeSection === id ? "bg-primary/10 font-medium text-text" : "text-muted",
              )}
            >
              {t(key)}
            </button>
          ))}
        </nav>
        <LoadFeedback
          loading={settings.isLoading}
          failed={settings.isError}
          onRetry={() => void settings.refetch()}
        />
        <Section id="settings-general" title={t("settings.section.general")}>
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
              value={i18n.language}
              onChange={(event) => {
                const next = event.target.value;
                if (isLanguage(next)) void setLanguage(next);
              }}
              className="h-9 rounded-md border border-border bg-bg px-2 text-sm text-text"
            >
              <option value="zh-CN">{t("settings.language.zhCN")}</option>
              <option value="en">{t("settings.language.en")}</option>
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
        <Section id="settings-floating" title={t("settings.section.floating")}>
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
        </Section>
        <Section id="settings-shortcuts" title={t("settings.section.shortcuts")}>
          <Row label={t("settings.shortcut.label")} hint={t("settings.shortcut.hint")}>
            <ShortcutSetting action="quickCreate" showStatus />
          </Row>
          <Row label={t("settings.searchShortcut.label")} hint={t("settings.searchShortcut.hint")}>
            <ShortcutSetting action="search" showStatus />
          </Row>
          <Row label={t("settings.searchPrewarm.label")} hint={t("settings.searchPrewarm.hint")}>
            <Switch
              label={t("settings.searchPrewarm.label")}
              checked={current?.searchPrewarm ?? false}
              disabled={current === undefined}
              onCheckedChange={(enabled) =>
                change.mutate({
                  patch: { searchPrewarm: enabled },
                  apply: () => ipc.setSearchPrewarm(enabled),
                })
              }
            />
          </Row>
        </Section>
        <Section id="settings-appearance" title={t("settings.section.appearance")}>
          <fieldset className="min-w-0 p-3">
            <legend className="px-1 text-sm font-medium text-text">
              {t("settings.appearance.group.badge")}
            </legend>
            <div className="divide-y divide-border">
              <Row label={t("settings.companion.mode")}>
                <Segmented
                  label={t("settings.companion.mode")}
                  value={skin.mode}
                  options={AVATAR_MODES}
                  render={(o) => t(`settings.companion.modes.${o}`)}
                  onChange={(mode) => updateSkin({ mode })}
                />
              </Row>
              {skin.mode === "robot" && (
                <>
                  <div
                    className="flex flex-wrap gap-2 py-3"
                    role="group"
                    aria-label={t("settings.companion.robot")}
                  >
                    {ROBOTS.map((robot) => (
                      <button
                        key={robot}
                        type="button"
                        aria-pressed={skin.robot === robot}
                        onClick={() => updateSkin({ robot })}
                        className={cx(
                          "flex min-w-24 flex-col items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium",
                          skin.robot === robot
                            ? "border-primary bg-primary/10 text-text"
                            : "border-border bg-bg text-text hover:bg-surface-hover",
                        )}
                      >
                        <span className="block h-9 w-12">
                          <RobotAvatar appearance={{ ...skin, robot }} />
                        </span>
                        {t(`settings.companion.robots.${robot}`)}
                      </button>
                    ))}
                  </div>
                  <Row label={t("settings.companion.color")}>
                    <Segmented
                      label={t("settings.companion.color")}
                      value={skin.color}
                      options={ROBOT_COLORS}
                      render={(o) => t(`settings.companion.colors.${o}`)}
                      onChange={(color) => updateSkin({ color })}
                    />
                  </Row>
                  <Row label={t("settings.companion.face")}>
                    <Segmented
                      label={t("settings.companion.face")}
                      value={skin.face}
                      options={ROBOT_FACES}
                      render={(o) => t(`settings.companion.faces.${o}`)}
                      onChange={(face) => updateSkin({ face })}
                    />
                  </Row>
                </>
              )}
              {skin.mode === "badge" && (
                <Row
                  label={t("settings.appearance.shape.label")}
                  hint={t("settings.appearance.shape.hint")}
                >
                  <Segmented
                    label={t("settings.appearance.shape.label")}
                    value={appearance.badgeShape}
                    options={BADGE_SHAPES}
                    render={(o) => t(`settings.appearance.shape.${o}`)}
                    onChange={(badgeShape) => updateAppearance({ badgeShape })}
                  />
                </Row>
              )}
              {skin.mode !== "badge" && (
                <Row
                  label={t("settings.skin.showCount.label")}
                  hint={t("settings.skin.showCount.hint")}
                >
                  <Switch
                    label={t("settings.skin.showCount.label")}
                    checked={skin.showCount}
                    onCheckedChange={(showCount) => updateSkin({ showCount })}
                  />
                </Row>
              )}
              <Row
                label={t("settings.appearance.corners.label")}
                hint={t("settings.appearance.corners.hint")}
              >
                <Segmented
                  label={t("settings.appearance.corners.label")}
                  value={appearance.corners}
                  options={CORNERS}
                  render={(o) => t(`settings.appearance.corners.${o}`)}
                  onChange={(corners) => updateAppearance({ corners })}
                />
              </Row>
            </div>
          </fieldset>
          <fieldset className="min-w-0 p-3">
            <legend className="px-1 text-sm font-medium text-text">
              {t("settings.appearance.group.surface")}
            </legend>
            <div className="divide-y divide-border">
              <Row
                label={t("settings.appearance.accent.label")}
                hint={t("settings.appearance.accent.hint")}
              >
                <div
                  role="radiogroup"
                  aria-label={t("settings.appearance.accent.label")}
                  className="flex gap-2"
                >
                  {ACCENTS.map((accent) => (
                    <button
                      key={accent}
                      type="button"
                      role="radio"
                      aria-checked={appearance.accent === accent}
                      aria-label={t(`settings.appearance.accent.${accent}`)}
                      onClick={() => updateAppearance({ accent })}
                      style={{ backgroundColor: ACCENT_SWATCH[accent] }}
                      className={cx(
                        "size-6 rounded-full transition-transform duration-(--nv-duration-fast)",
                        appearance.accent === accent
                          ? "scale-110 ring-2 ring-text ring-offset-2 ring-offset-surface"
                          : "hover:scale-110",
                      )}
                    />
                  ))}
                </div>
              </Row>
              <Row
                label={t("settings.appearance.surface.label")}
                hint={t("settings.appearance.surface.hint")}
              >
                <Segmented
                  label={t("settings.appearance.surface.label")}
                  value={appearance.surface}
                  options={SURFACES}
                  render={(o) => t(`settings.appearance.surface.${o}`)}
                  onChange={(surface) => updateAppearance({ surface })}
                />
              </Row>
              <Row
                label={t("settings.appearance.opacity.label")}
                hint={t("settings.appearance.opacity.hint")}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    aria-label={t("settings.appearance.opacity.label")}
                    min={MIN_OPACITY}
                    max={MAX_OPACITY}
                    step={5}
                    value={appearance.opacity}
                    onChange={(event) => updateAppearance({ opacity: Number(event.target.value) })}
                    className="w-32 accent-(--nv-primary)"
                  />
                  <span className="w-10 text-right text-xs text-muted tabular-nums">
                    {`${appearance.opacity}%`}
                  </span>
                </div>
              </Row>
              <Row
                label={t("settings.appearance.reset.label")}
                hint={t("settings.appearance.reset.hint")}
              >
                <Button size="sm" onClick={resetAppearance}>
                  {t("settings.appearance.reset.button")}
                </Button>
              </Row>
            </div>
          </fieldset>
          {skin.mode === "image" && (
            <fieldset className="min-w-0 p-3">
              <legend className="px-1 text-sm font-medium text-text">
                {t("settings.appearance.group.skin")}
              </legend>
              <div className="divide-y divide-border">
                <Row label={t("settings.skin.label")} hint={t("settings.skin.hint")}>
                  <SkinSetting />
                </Row>
                <Row label={t("settings.skin.pixel.label")} hint={t("settings.skin.pixel.hint")}>
                  <Switch
                    label={t("settings.skin.pixel.label")}
                    checked={skin.pixel}
                    onCheckedChange={(pixel) => updateSkin({ pixel })}
                  />
                </Row>
              </div>
            </fieldset>
          )}
          {skin.mode === "image" && (
            <fieldset className="min-w-0 p-3">
              <legend className="px-1 text-sm font-medium text-text">
                {t("settings.appearance.group.motion")}
              </legend>
              <div className="divide-y divide-border">
                <Row
                  label={t("settings.skin.playback.label")}
                  hint={t("settings.skin.playback.hint")}
                >
                  <Segmented
                    label={t("settings.skin.playback.label")}
                    value={skin.playback}
                    options={PLAYBACKS}
                    render={(o) => t(`settings.skin.playback.${o}`)}
                    onChange={(playback) => updateSkin({ playback })}
                  />
                </Row>
                <Row label={t("settings.skin.fps.label")} hint={t("settings.skin.fps.hint")}>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      aria-label={t("settings.skin.fps.label")}
                      min={MIN_FPS}
                      max={MAX_FPS}
                      step={1}
                      value={skin.fps}
                      onChange={(event) => updateSkin({ fps: Number(event.target.value) })}
                      className="w-32 accent-(--nv-primary)"
                    />
                    <span className="w-10 text-right text-xs text-muted tabular-nums">
                      {skin.fps}
                    </span>
                  </div>
                </Row>
                <Row label={t("settings.skin.motion.label")} hint={t("settings.skin.motion.hint")}>
                  <Segmented
                    label={t("settings.skin.motion.label")}
                    value={skin.motion}
                    options={MOTIONS}
                    render={(o) => t(`settings.skin.motion.${o}`)}
                    onChange={(motion) => updateSkin({ motion })}
                  />
                </Row>
              </div>
            </fieldset>
          )}
        </Section>
        <Section id="settings-notifications" title={t("settings.section.notifications")}>
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
        <Section id="settings-onboarding" title={t("settings.onboarding.label")}>
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
        <Section id="settings-schedule" title={t("settings.section.schedule")}>
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
          <Row label={t("settings.hideCompleted.label")} hint={t("settings.hideCompleted.hint")}>
            <Switch
              label={t("settings.hideCompleted.label")}
              checked={hideCompleted}
              onCheckedChange={setHideCompleted}
            />
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
        <Section id="settings-integrations" title={t("settings.section.integrations")}>
          <IntegrationsSetting />
        </Section>
        <Section id="settings-about" title={t("settings.section.about")}>
          <Row label={t("settings.update.label")} hint={t("settings.update.hint")}>
            <UpdateSetting />
          </Row>
        </Section>
        <Section id="settings-data" title={t("settings.section.data")}>
          <Row label={t("settings.diagnostics.label")} hint={t("settings.diagnostics.hint")}>
            <Button
              size="sm"
              variant="secondary"
              aria-label={t("settings.diagnostics.label")}
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
          <Row label={t("settings.exportData.label")} hint={t("settings.exportData.hint")}>
            <div className="flex items-center gap-2">
              <select
                aria-label={t("settings.exportData.format")}
                value={exportFormat}
                onChange={(event) => {
                  const next = EXPORT_FORMATS.find((f) => f === event.target.value);
                  if (next !== undefined) setExportFormat(next);
                }}
                className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
              >
                {EXPORT_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {t(`settings.exportData.${format}`)}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="secondary"
                aria-label={t("settings.exportData.label")}
                onClick={() => {
                  ipc
                    .exportData(exportFormat)
                    .then((result) =>
                      useToastStore.getState().push(
                        "success",
                        t("settings.exportData.done", {
                          count: result.itemCount,
                          path: result.path,
                        }),
                      ),
                    )
                    .catch(reportError);
                }}
              >
                {t("settings.exportData.action")}
              </Button>
            </div>
          </Row>
          <Row label={t("settings.backup.label")} hint={t("settings.backup.hint")}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                ipc
                  .createBackupFile()
                  .then((path) =>
                    useToastStore.getState().push("success", t("settings.backup.done", { path })),
                  )
                  .catch(reportError);
              }}
            >
              {t("settings.backup.action")}
            </Button>
          </Row>
          <Row label={t("settings.restore.label")} hint={t("settings.restore.hint")}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                ipc
                  .restoreBackup()
                  .then((result) => {
                    setStaged(result);
                    // 后端以最后一次选择为准：恢复会取消已暂存的清空。
                    if (result !== null) setResetSafety(null);
                  })
                  .catch(reportError);
              }}
            >
              {t("settings.restore.action")}
            </Button>
          </Row>
          {staged !== null && (
            <div role="status" className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{t("settings.restore.readyTitle")}</p>
                <p className="mt-0.5 break-all text-xs text-muted">
                  {t("settings.restore.readyBody", {
                    created: staged.createdAt,
                    version: staged.appVersion,
                    safety: staged.safetyBackup,
                  })}
                </p>
              </div>
              <Button size="sm" onClick={() => void ipc.restartApp().catch(reportError)}>
                {t("settings.restore.restart")}
              </Button>
            </div>
          )}
          <Row label={t("settings.reset.label")} hint={t("settings.reset.hint")}>
            <ConfirmButton
              size="sm"
              variant="secondary"
              label={t("settings.reset.action")}
              confirmLabel={t("settings.reset.confirm")}
              onConfirm={() => {
                ipc
                  .resetAllData()
                  .then((safety) => {
                    // 浮窗的语言 / 主题偏好存在 WebView 的 localStorage 里，一并清掉。
                    try {
                      localStorage.clear();
                    } catch {
                      // 存储不可用时无事可清。
                    }
                    setStaged(null);
                    setResetSafety(safety);
                  })
                  .catch(reportError);
              }}
            />
          </Row>
          {resetSafety !== null && (
            <div role="status" className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{t("settings.reset.readyTitle")}</p>
                <p className="mt-0.5 break-all text-xs text-muted">
                  {t("settings.reset.readyBody", { safety: resetSafety })}
                </p>
              </div>
              <Button size="sm" onClick={() => void ipc.restartApp().catch(reportError)}>
                {t("settings.reset.restart")}
              </Button>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
