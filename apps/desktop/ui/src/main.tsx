import { getCurrentWindow } from "@tauri-apps/api/window";
import i18next from "i18next";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FloatingApp } from "@/app/floating/FloatingApp";
import { MainApp } from "@/app/main/MainApp";
import { AppProviders } from "@/app/providers/AppProviders";
import { hydrateLanguage, initI18n } from "@/i18n";
import { ipc, isRunningInTauri, setIpcClient } from "@/lib/ipc";
import { initAppearance, useAppearanceStore } from "@/stores/appearance-store";
import { initDisplay, useDisplayStore } from "@/stores/display-store";
import { initSkin, useSkinStore } from "@/stores/skin-store";
import { applyTheme, useThemeStore } from "@/stores/theme-store";
import "@/styles/global.css";

/** 悬浮窗的窗口 label，与后端窗口配置一致（架构文档 §10）。 */
const FLOATING_WINDOW_LABEL = "floating";

/** 从后端读取外观、皮肤、语言与主题，覆盖本地缓存；失败时沿用缓存。 */
async function hydrateUiPrefs(): Promise<void> {
  try {
    const [appearance, skin, language, theme, hideCompleted] = await Promise.all([
      ipc.getUiPref("appearance"),
      ipc.getUiPref("skin"),
      ipc.getUiPref("language"),
      ipc.getUiPref("theme"),
      ipc.getUiPref("hideCompleted"),
    ]);
    if (appearance) useAppearanceStore.getState().hydrate(appearance);
    if (skin) useSkinStore.getState().hydrate(skin);
    if (language) await hydrateLanguage(language);
    if (theme) useThemeStore.getState().hydrate(theme);
    if (hideCompleted) useDisplayStore.getState().hydrate(hideCompleted);
    // 升级前只存在 localStorage 的语言 / 主题：后端还没有记录时补写一次，让备份与 Rust 侧能读到。
    if (!language) await ipc.setUiPref("language", i18next.language);
    if (!theme) await ipc.setUiPref("theme", useThemeStore.getState().preference);
  } catch {
    // 后端暂不可用：沿用 localStorage 缓存。
  }
}

/**
 * 应用启动：按窗口 label 选择入口并渲染。
 *
 * 在普通浏览器中（`pnpm dev:ui`）没有 Tauri 后端，改用内存版 IPC Mock，
 * 这样可以不启动 Rust 就调试界面（前端规范 §6.5）。
 *
 * @returns 渲染完成后结束的 Promise。
 */
async function bootstrap(): Promise<void> {
  initI18n();
  // 在渲染前就应用主题，避免先闪一下浅色再切到深色。
  applyTheme(useThemeStore.getState().preference);
  initAppearance();
  initSkin();
  initDisplay();

  let label: string;
  if (isRunningInTauri()) {
    label = getCurrentWindow().label;
  } else {
    const { createMemoryIpc } = await import("@/test/ipc-mock");
    const { seedDemoData } = await import("@/test/dev-seed");
    const memory = createMemoryIpc();
    await seedDemoData(memory);
    setIpcClient(memory);
    // 预览悬浮窗：http://localhost:1420/?window=floating
    label = new URLSearchParams(window.location.search).get("window") ?? "main";
  }

  // 主窗口启动时以后端保存的外观 / 皮肤为准（备份恢复后也能还原）；悬浮窗靠 storage 事件同步。
  if (label !== FLOATING_WINDOW_LABEL) void hydrateUiPrefs();

  // 让样式能按窗口区分（悬浮窗需要透明背景）。
  document.documentElement.dataset["window"] = label;

  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("缺少 #root 挂载节点");
  }
  createRoot(container).render(
    <StrictMode>
      <AppProviders>{label === FLOATING_WINDOW_LABEL ? <FloatingApp /> : <MainApp />}</AppProviders>
    </StrictMode>,
  );
}

void bootstrap();
