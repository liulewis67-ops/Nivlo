import { beforeEach, describe, expect, it } from "vitest";
import { resolveTheme, useThemeStore } from "./theme-store";

describe("主题 Store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset["theme"];
    useThemeStore.setState({ preference: "system" });
  });

  it("设置偏好后更新根元素 data-theme 并保存", () => {
    useThemeStore.getState().setPreference("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(window.localStorage.getItem("nivlo.theme")).toBe("dark");

    useThemeStore.getState().setPreference("light");
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });

  it("跟随系统时按系统配色决定（测试环境为浅色）", () => {
    expect(resolveTheme("system")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });
});
