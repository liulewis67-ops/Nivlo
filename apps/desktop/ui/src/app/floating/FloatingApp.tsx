import { FloatingRoot } from "@/features/floating";

/**
 * 悬浮窗的根组件。
 *
 * 悬浮窗包体应尽量小：这里只引入悬浮窗需要的 feature，不引入主窗口专用的内容
 * （前端规范 §5、§9）。
 *
 * @returns 悬浮窗内容。
 */
export function FloatingApp() {
  return <FloatingRoot />;
}
