import { FloatingRoot } from "@/features/floating";
import { OpenItemContext } from "@/features/detail";
import { ipc } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";

/** 悬浮窗的事项详情由主窗口承载，沿用按 ID 定位的窗口接口。 */
function openItem(id: string): void {
  void ipc.openItemInMain(id).catch(reportError);
}

/**
 * 悬浮窗的根组件。
 *
 * 悬浮窗包体应尽量小：这里只引入悬浮窗需要的 feature，不引入主窗口专用的内容
 * （前端规范 §5、§9）。
 *
 * @returns 悬浮窗内容。
 */
export function FloatingApp() {
  return (
    <OpenItemContext.Provider value={openItem}>
      <FloatingRoot />
    </OpenItemContext.Provider>
  );
}
