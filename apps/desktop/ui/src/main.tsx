import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FloatingApp } from "@/app/floating/FloatingApp";
import { MainApp } from "@/app/main/MainApp";
import { AppProviders } from "@/app/providers/AppProviders";
import { initI18n } from "@/i18n";
import { isRunningInTauri, setIpcClient } from "@/lib/ipc";
import { applyTheme, useThemeStore } from "@/stores/theme-store";
import "@/styles/global.css";

/** 悬浮窗的窗口 label，与后端窗口配置一致（架构文档 §10）。 */
const FLOATING_WINDOW_LABEL = "floating";

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
