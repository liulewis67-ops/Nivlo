import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { ipc } from "@/lib/ipc";
import en from "./en.json";
import zhCN from "./zh-CN.json";

/** 默认语言（实施计划 D-06）。 */
export const DEFAULT_LANGUAGE = "zh-CN";

/** 支持的界面语言。 */
export const LANGUAGES = ["zh-CN", "en"] as const;

/** 界面语言。 */
export type Language = (typeof LANGUAGES)[number];

/** 语言偏好在 localStorage 中的 key；仅是 UI 便利，读取失败时用默认语言。 */
const STORAGE_KEY = "nivlo.language";

/**
 * 判断一个值是不是支持的语言。
 *
 * @param value 任意值。
 * @returns 是则为 `true`。
 */
export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language === value);
}

/**
 * 读取已保存的语言。
 *
 * @returns 已保存的语言；没有保存、值非法或 localStorage 不可用时为默认语言。
 */
function savedLanguage(): Language {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    // localStorage 在隐私模式等场景下可能抛出，按默认语言处理即可。
  }
  return DEFAULT_LANGUAGE;
}

/**
 * 把语言写到根元素，辅助技术据此选择朗读语音。
 *
 * @param language 语言。
 */
function applyLanguage(language: Language): void {
  document.documentElement.lang = language;
}

/**
 * 切换界面语言：立即生效并保存；其他窗口（悬浮窗）通过 `storage` 事件同步。
 *
 * @param language 新语言。
 */
export async function setLanguage(language: Language): Promise<void> {
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // 无法保存只影响「下次启动记住语言」。
  }
  applyLanguage(language);
  // 写入后端（settings 表）：随备份，并让 Rust 侧的托盘 / 对话框 / 通知使用同一语言。
  ipc.setUiPref("language", language).catch(() => undefined);
  await i18next.changeLanguage(language);
}

/**
 * 用后端保存的语言覆盖本地缓存（主窗口启动时、备份恢复后）；非法值忽略。
 *
 * @param value 后端保存的语言文本。
 */
export async function hydrateLanguage(value: string): Promise<void> {
  if (!isLanguage(value) || value === i18next.language) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 缓存写入失败不影响当前会话。
  }
  applyLanguage(value);
  await i18next.changeLanguage(value);
}

/**
 * 初始化 i18n：同步加载内置资源，保证首次渲染就有文案。
 *
 * 重复调用是安全的，只有第一次会真正初始化。
 *
 * @returns 已初始化的 i18next 实例。
 */
export function initI18n(): typeof i18next {
  if (!i18next.isInitialized) {
    const language = savedLanguage();
    void i18next.use(initReactI18next).init({
      resources: { "zh-CN": { translation: zhCN }, en: { translation: en } },
      lng: language,
      fallbackLng: DEFAULT_LANGUAGE,
      interpolation: { escapeValue: false },
      initAsync: false,
    });
    applyLanguage(language);
    // 另一个窗口切换了语言：这个窗口跟着切换。
    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEY && isLanguage(event.newValue)) {
        applyLanguage(event.newValue);
        void i18next.changeLanguage(event.newValue);
      }
    });
  }
  return i18next;
}
