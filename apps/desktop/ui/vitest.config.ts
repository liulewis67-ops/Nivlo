import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

/** Vitest 配置：复用 Vite 的别名，组件测试使用 jsdom。 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      // vmThreads：每个测试文件仍然隔离，但不再为每个文件重新启动 Worker 和 jsdom。
      // 2026-10-27 在本机实测：全量 530 个测试 44.9s → 约 14s，连续 4 次全部通过。
      pool: "vmThreads",
      include: ["src/**/*.test.{ts,tsx}"],
      setupFiles: ["./src/test/setup.ts"],
      css: false,
    },
  }),
);
