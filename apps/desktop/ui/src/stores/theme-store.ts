import { create } from "zustand";

/** 用户的主题偏好。 */
export type ThemePreference = "system" | "light" | "dark";

/** 偏好在 localStorage 中的 key；仅是 UI 便利，读取失败时回退到跟随系统。 */
const STORAGE_KEY = "nivlo.theme";

/**
 * 读取已保存的主题偏好。
 *
 * @returns 已保存的偏好；没有保存、值非法或 localStorage 不可用时为 `system`。
 */
function loadPreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // localStorage 在隐私模式等场景下可能抛出，此时按默认值处理即可。
  }
  return "system";
}

/**
 * 计算实际生效的主题。
 *
 * @param preference 用户偏好。
 * @returns `light` 或 `dark`；`system` 时按系统配色决定。
 */
export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * 把主题写到根元素的 `data-theme`，Design Token 据此切换（前端规范 §8.1）。
 *
 * @param preference 用户偏好。
 */
export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset["theme"] = resolveTheme(preference);
}

/** 主题 Store 的状态与动作。 */
type ThemeState = {
  /** 当前偏好。 */
  preference: ThemePreference;
  /** 设置偏好，立即应用并保存。 */
  setPreference: (preference: ThemePreference) => void;
};

/** 主题偏好的 Zustand Store。 */
export const useThemeStore = create<ThemeState>((set) => ({
  preference: loadPreference(),
  setPreference: (preference) => {
    applyTheme(preference);
    try {
      window.localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // 无法保存只影响"下次启动记住偏好"，不影响当前会话。
    }
    set({ preference });
  },
}));
