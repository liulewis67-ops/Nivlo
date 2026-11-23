import { getCurrentWindow } from "@tauri-apps/api/window";
import i18next from "i18next";
import { StrictMode } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/app/providers/AppProviders";
import { hydrateLanguage, initI18n } from "@/i18n";
import { ipc, isRunningInTauri, setIpcClient } from "@/lib/ipc";
import { blockBrowserReflexKeys } from "@/lib/browser-keys";
import { initAppearance, useAppearanceStore } from "@/stores/appearance-store";
import { initDisplay, useDisplayStore } from "@/stores/display-store";
import { initSkin, useSkinStore } from "@/stores/skin-store";
import { applyTheme, useThemeStore } from "@/stores/theme-store";
import "@/styles/global.css";

/** 悬浮窗的窗口 label，与后端窗口配置一致（架构文档 §10）。 */
const FLOATING_WINDOW_LABEL = "floating";

/** 全局搜索窗口的 label，与后端 `windows::search` 一致。 */
const SEARCH_WINDOW_LABEL = "search";

/**
 * 按窗口 label 加载根组件（各自一个代码块）。
 *
 * 三个窗口共用一个入口，但悬浮窗与全局搜索框只需要自己的那一小部分：主窗口的视图（日历、Workflow、
 * 脚本编辑器……）放在单独的块里，不必下载和解析。实测全局搜索框第一次唤出快约 50 ms，悬浮窗启动快约
 * 30 ms、堆少约 1 MB（见 `docs/development/perf-baseline.md`）。
 *
 * @param label 窗口 label。
 * @returns 根组件。
 */
async function loadRoot(label: string): Promise<ComponentType> {
  if (label.startsWith("detail-") || label === "detail")
    return (await import("@/app/detail/DetailApp")).DetailApp;
  if (label === FLOATING_WINDOW_LABEL)
    return (await import("@/app/floating/FloatingApp")).FloatingApp;
  if (label === SEARCH_WINDOW_LABEL) return (await import("@/features/search/SearchApp")).SearchApp;
  return (await import("@/app/main/MainApp")).MainApp;
}

/** 从后端读取外观、皮肤、语言与主题，覆盖本地缓存；失败时沿用缓存。 */
async function hydrateUiPrefs(): Promise<void> {
  try {
    const cachedAppearance = useAppearanceStore.getState().appearance;
    const cachedSkin = useSkinStore.getState().skin;
    const [appearance, skin, language, theme, hideCompleted] = await Promise.all([
      ipc.getUiPref("appearance"),
      ipc.getUiPref("skin"),
      ipc.getUiPref("language"),
      ipc.getUiPref("theme"),
      ipc.getUiPref("hideCompleted"),
    ]);
    if (appearance && cachedAppearance === useAppearanceStore.getState().appearance) {
      useAppearanceStore.getState().hydrate(appearance);
    }
    if (cachedSkin === useSkinStore.getState().skin) {
      useSkinStore.getState().hydrate(skin);
      void useSkinStore.getState().migrateLegacyFrames();
    }
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
    // 发布版里 F5 / Ctrl+R 会把整个界面刷新掉（丢掉没保存的输入），Ctrl+P / Ctrl+S 弹出浏览器的打印与另存；
    // 开发时保留 F5 刷新。
    if (!import.meta.env.DEV) blockBrowserReflexKeys(window);
  } else if (import.meta.env.DEV) {
    // 浏览器预览只在开发服务器里有：生产构建不带内存 Mock 与演示数据（约 35 KB，安装包里用不到）。
    const { createMemoryIpc } = await import("@/test/ipc-mock");
    const { seedDemoData } = await import("@/test/dev-seed");
    const memory = createMemoryIpc();
    await seedDemoData(memory);
    // 预览悬浮窗：http://localhost:1420/?window=floating；全局搜索框：?window=search
    label = new URLSearchParams(window.location.search).get("window") ?? "main";
    if (
      label === "detail" &&
      !new URLSearchParams(window.location.search).has("item") &&
      memory.items[0]
    ) {
      const url = new URL(window.location.href);
      url.searchParams.set("item", memory.items[0].id);
      history.replaceState(null, "", url);
    }
    const { previewWindows } = await import("@/test/preview-windows");
    setIpcClient(previewWindows(memory, label));
  } else {
    throw new Error(
      "Nivlo UI must run inside Tauri; use the Vite dev server for a browser preview.",
    );
  }

  const rootPromise = loadRoot(label);

  // 悬浮窗先于主窗口启动时，也从数据库读取备份恢复后的皮肤。
  if (label === FLOATING_WINDOW_LABEL && isRunningInTauri()) {
    try {
      const cached = useSkinStore.getState().skin;
      const saved = await ipc.getUiPref("skin");
      if (cached === useSkinStore.getState().skin) useSkinStore.getState().hydrate(saved);
    } catch {
      // 后端暂不可用时沿用上一次保存的缓存。
    }
  } else if (label !== FLOATING_WINDOW_LABEL && label !== SEARCH_WINDOW_LABEL) {
    void hydrateUiPrefs();
  }

  // 让样式能按窗口区分（悬浮窗需要透明背景）。
  document.documentElement.dataset["window"] = label;

  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("缺少 #root 挂载节点");
  }
  const Root = await rootPromise;
  createRoot(container).render(
    <StrictMode>
      <AppProviders>
        <Root />
      </AppProviders>
    </StrictMode>,
  );
}

void bootstrap();
