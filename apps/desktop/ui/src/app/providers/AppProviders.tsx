import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { ToastViewport, TooltipProvider } from "@/components";
import { initI18n } from "@/i18n";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { applyTheme, useThemeStore } from "@/stores/theme-store";
import { useToastStore } from "@/stores/toast-store";

/**
 * 把查询 / 变更失败统一显示为错误 Toast。
 *
 * 文案来自 i18n（以错误码为 key），后端 `message` 只进日志（前端规范 §6.3）。
 *
 * @param error 抛出的任意错误。
 */
function reportError(error: unknown): void {
  const appError = toAppError(error);
  console.error(`[${appError.code}] ${appError.message}`);
  useToastStore.getState().push("error", errorMessage(appError));
}

/**
 * 创建应用使用的 `QueryClient`。
 *
 * * 领域数据由事件驱动刷新，因此默认不在窗口聚焦时重取；
 * * 失败统一弹 Toast；查询不自动重试，避免掩盖后端的确定性错误。
 *
 * @returns 新的 `QueryClient`。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reportError }),
    mutationCache: new MutationCache({ onError: reportError }),
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
  });
}

/** [`AppProviders`] 的 Props。 */
export type AppProvidersProps = {
  /** 窗口根组件。 */
  children: ReactNode;
  /** 可注入的 `QueryClient`，测试用；缺省时创建新的。 */
  queryClient?: QueryClient;
};

/**
 * 应用根 Provider：i18n、查询缓存、主题、Tooltip 与 Toast。
 *
 * 悬浮窗与主窗口共享这一层，但不共享路由（前端规范 §5）。
 * 同时负责两项全局订阅，卸载时都会取消：
 *
 * * 系统配色变化（偏好为"跟随系统"时）→ 更新 `data-theme`；
 * * 后端 Item 事件 → 让 Item 查询失效。事件只携带 ID，回调里不做重计算或连续 IPC（前端规范 §6.4）。
 *
 * @param props 子树与可选的测试用 `QueryClient`。
 * @returns Provider 树。
 */
export function AppProviders({ children, queryClient }: AppProvidersProps) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const preference = useThemeStore((state) => state.preference);

  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    /** 系统配色变化时重新应用"跟随系统"的主题。 */
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  useEffect(
    () =>
      ipc.subscribeItemChanges(() => {
        void client.invalidateQueries({ queryKey: queryKeys.items() });
      }),
    [client],
  );

  return (
    <I18nextProvider i18n={initI18n()}>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          {children}
          <ToastViewport />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
