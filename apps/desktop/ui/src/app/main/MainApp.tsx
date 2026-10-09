import { DevConsole } from "@/features/dev-console";

/**
 * 主窗口的根组件。
 *
 * Phase 0 只挂载开发控制台；Phase 1.10 起替换为带导航的主窗口外壳。
 *
 * @returns 主窗口内容。
 */
export function MainApp() {
  return <DevConsole />;
}
