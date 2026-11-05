import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { ToastViewport, TooltipProvider } from "@/components";
import { initI18n } from "@/i18n";
import { coalesce } from "@/lib/coalesce";
import { ipc } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { applyTheme, useThemeStore } from "@/stores/theme-store";

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
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.meta?.errorPresentation !== "inline") reportError(error);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.errorPresentation !== "inline") reportError(error);
      },
    }),
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
  });
}

/** 合并后端数据变化事件的窗口（毫秒）：单个事件立即刷新，一串事件在窗口结束时再刷新一次。 */
const DATA_CHANGE_WINDOW_MS = 50;

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

  useEffect(() => {
    // 批量操作会连续到达 N 个事件：合并成「立即一轮 + 窗口结束再一轮」，而不是重取 N 轮。
    const refresh = coalesce(() => {
      void client.invalidateQueries({ queryKey: queryKeys.items() });
      void client.invalidateQueries({ queryKey: queryKeys.today() });
      void client.invalidateQueries({ queryKey: queryKeys.inbox() });
      void client.invalidateQueries({ queryKey: queryKeys.itemsOne() });
      void client.invalidateQueries({ queryKey: queryKeys.projects() });
      void client.invalidateQueries({ queryKey: queryKeys.tags() });
      void client.invalidateQueries({ queryKey: queryKeys.trash() });
    }, DATA_CHANGE_WINDOW_MS);
    const unsubscribe = ipc.subscribeDataChanges(refresh.signal);
    return () => {
      unsubscribe();
      refresh.cancel();
    };
  }, [client]);

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
