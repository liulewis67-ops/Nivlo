import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { initI18n } from "@/i18n";
import { useNavStore } from "@/features/shell/nav-store";
import { useDraftTransitionStore } from "@/stores/draft-transition-store";

// 所有测试共用同一份 zh-CN 资源，断言直接使用用户可见文案。
initI18n();

// jsdom 没有 matchMedia；主题逻辑需要它。默认模拟"浅色系统配色"。
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom 没有 scrollIntoView（设置页的分组跳转用到）。
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => undefined;
}

afterEach(() => {
  cleanup();
  useNavStore.setState({ detailId: null });
  useDraftTransitionStore.getState().cancel();
});
