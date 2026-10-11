import { create } from "zustand";
import { ipc } from "@/lib/ipc";

/** 悬浮窗强调色预设。 */
export const ACCENTS = ["blue", "violet", "teal", "rose", "amber"] as const;
/** 强调色名称。 */
export type Accent = (typeof ACCENTS)[number];

/** 徽标形态：胶囊（圆点 + 数字）、圆形（只有数字）、迷你圆点。 */
export const BADGE_SHAPES = ["pill", "circle", "dot"] as const;
/** 徽标形态名称。 */
export type BadgeShape = (typeof BADGE_SHAPES)[number];

/** 面板质感：纯色或通透。 */
export const SURFACES = ["solid", "glass"] as const;
/** 面板质感名称。 */
export type Surface = (typeof SURFACES)[number];

/** 圆角档位。 */
export const CORNERS = ["soft", "round"] as const;
/** 圆角档位名称。 */
export type Corners = (typeof CORNERS)[number];

/** 悬浮窗外观偏好。 */
export type Appearance = {
  accent: Accent;
  badgeShape: BadgeShape;
  surface: Surface;
  corners: Corners;
  /** 悬浮窗整体不透明度，百分比 40–100。 */
  opacity: number;
};

export const DEFAULT_APPEARANCE: Appearance = {
  accent: "blue",
  badgeShape: "pill",
  surface: "glass",
  corners: "round",
  opacity: 100,
};

export const MIN_OPACITY = 40;
export const MAX_OPACITY = 100;

/** 偏好在 localStorage 中的 key；悬浮窗与主窗口共用，靠 `storage` 事件同步。 */
export const APPEARANCE_STORAGE_KEY = "nivlo.appearance";

/** 按白名单取值，非法时回退。 */
function pick<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * 校验并补全任意来源的外观偏好，非法字段回退到默认值。
 *
 * @param raw 解析后的 JSON。
 * @returns 合法的外观偏好。
 */
export function sanitizeAppearance(raw: unknown): Appearance {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawOpacity = o["opacity"];
  const opacity =
    typeof rawOpacity === "number" && Number.isFinite(rawOpacity)
      ? Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Math.round(rawOpacity)))
      : DEFAULT_APPEARANCE.opacity;
  return {
    accent: pick(ACCENTS, o["accent"], DEFAULT_APPEARANCE.accent),
    badgeShape: pick(BADGE_SHAPES, o["badgeShape"], DEFAULT_APPEARANCE.badgeShape),
    surface: pick(SURFACES, o["surface"], DEFAULT_APPEARANCE.surface),
    corners: pick(CORNERS, o["corners"], DEFAULT_APPEARANCE.corners),
    opacity,
  };
}

/** 读取已保存的外观偏好。 */
function load(): Appearance {
  try {
    const saved = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (saved !== null) return sanitizeAppearance(JSON.parse(saved));
  } catch {
    // localStorage 不可用或内容损坏：使用默认外观。
  }
  return DEFAULT_APPEARANCE;
}

/**
 * 把外观偏好写到根元素的 data 属性与 CSS 变量，样式据此切换。
 *
 * @param appearance 外观偏好。
 */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  root.dataset["accent"] = appearance.accent;
  root.dataset["surface"] = appearance.surface;
  root.dataset["corners"] = appearance.corners;
  root.style.setProperty("--nv-float-opacity", String(appearance.opacity / 100));
}

/** 外观状态与操作。 */
type AppearanceState = {
  appearance: Appearance;
  /** 修改部分字段，立即应用并保存。 */
  update: (patch: Partial<Appearance>) => void;
  /** 恢复默认外观。 */
  reset: () => void;
  /** 接收其他窗口的修改（只应用，不回写）。 */
  adopt: (appearance: Appearance) => void;
  /** 用后端保存的 JSON 覆盖本地缓存（启动时、备份恢复后）。 */
  hydrate: (json: string) => void;
};

export const useAppearanceStore = create<AppearanceState>((set, get) => {
  /** 把外观写入根元素并持久化。 */
  const commit = (next: Appearance): void => {
    applyAppearance(next);
    try {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 无法保存只影响下次启动，不影响当前会话。
    }
    set({ appearance: next });
    // 同步写入后端（settings 表，随备份）；失败只影响备份，不影响当前会话。
    ipc.setUiPref("appearance", JSON.stringify(next)).catch(() => undefined);
  };
  return {
    appearance: load(),
    update: (patch) => commit(sanitizeAppearance({ ...get().appearance, ...patch })),
    reset: () => commit(DEFAULT_APPEARANCE),
    adopt: (appearance) => {
      applyAppearance(appearance);
      set({ appearance });
    },
    hydrate: (json) => {
      try {
        const next = sanitizeAppearance(JSON.parse(json));
        window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
        applyAppearance(next);
        set({ appearance: next });
      } catch {
        // 内容损坏时保留本地缓存。
      }
    },
  };
});

/** 启动时应用已保存的外观，并监听其他窗口的修改。 */
export function initAppearance(): void {
  applyAppearance(useAppearanceStore.getState().appearance);
  window.addEventListener("storage", (event) => {
    if (event.key !== APPEARANCE_STORAGE_KEY) return;
    try {
      const next =
        event.newValue === null
          ? DEFAULT_APPEARANCE
          : sanitizeAppearance(JSON.parse(event.newValue));
      useAppearanceStore.getState().adopt(next);
    } catch {
      // 内容损坏时忽略。
    }
  });
}
