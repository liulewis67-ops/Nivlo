import { defineConfig } from "vitest/config";

/** Vitest 配置：默认 Node 环境，组件测试在 0.9 引入 jsdom。 */
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
