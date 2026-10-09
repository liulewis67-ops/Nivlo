import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN.json";

/** 默认语言（实施计划 D-06）；英文在 Phase 7.5 补齐。 */
export const DEFAULT_LANGUAGE = "zh-CN";

/**
 * 初始化 i18n：同步加载内置资源，保证首次渲染就有文案。
 *
 * 重复调用是安全的，只有第一次会真正初始化。
 *
 * @returns 已初始化的 i18next 实例。
 */
export function initI18n(): typeof i18next {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      resources: { [DEFAULT_LANGUAGE]: { translation: zhCN } },
      lng: DEFAULT_LANGUAGE,
      fallbackLng: DEFAULT_LANGUAGE,
      interpolation: { escapeValue: false },
      initAsync: false,
    });
  }
  return i18next;
}
