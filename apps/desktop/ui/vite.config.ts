import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Vite 配置：固定端口供 Tauri `devUrl` 使用，并避免遮挡 Rust 编译输出。 */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
