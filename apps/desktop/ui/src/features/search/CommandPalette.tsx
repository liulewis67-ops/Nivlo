import { useEffect, useRef } from "react";
import { trapTab } from "@/lib/focus-trap";
import { useTranslation } from "react-i18next";
import { useShortcutQuery } from "@/features/shortcut";
import { SearchPanel } from "./SearchPanel";
import type { PaletteCommand } from "./SearchPanel";

/** [`CommandPalette`] 的 Props。 */
export type CommandPaletteProps = {
  /** 关闭面板。 */
  onClose: () => void;
  /** 选中一条结果（回车或点击）；调用后面板自动关闭。 */
  onOpenItem: (id: string) => void;
  /** 输入 `>` 时列出的命令；执行后面板自动关闭。 */
  commands?: readonly PaletteCommand[] | undefined;
};

/**
 * 主窗口的搜索浮层（实施计划 3.4，Ctrl+K 打开）：遮罩 + [`SearchPanel`]。
 *
 * * 打开时输入框聚焦，关闭时焦点回到打开之前的元素；
 * * 点击面板外的遮罩关闭；
 * * 底部提示全局搜索的快捷键，让用户知道在其他应用里也能直接搜；
 * * Ctrl+Enter 把搜索词建成待办，并直接打开它的详情，方便接着补充；
 * * 输入 `>` 进入命令模式（前往某个视图等），回车执行后关闭。
 *
 * @param props 关闭与打开回调。
 * @returns 对话框。
 */
export function CommandPalette({ onClose, onOpenItem, commands }: CommandPaletteProps) {
  const { t } = useTranslation();
  const previouslyFocused = useRef<Element | null>(document.activeElement);
  const dialogRef = useRef<HTMLDivElement>(null);
  const transferred = useRef(false);
  const global = useShortcutQuery("search").data;

  // 关闭时把焦点还给打开之前的元素。
  useEffect(() => {
    const target = previouslyFocused.current;
    const dialog = dialogRef.current;
    return () => {
      const active = document.activeElement;
      if (
        !transferred.current &&
        (active === document.body || active === null || dialog?.contains(active)) &&
        target instanceof HTMLElement &&
        target.isConnected
      )
        target.focus();
    };
  }, []);

  return (
    <div
      className="nv-drop-zone fixed inset-0 z-(--nv-z-dialog) flex items-start justify-center bg-text/30 px-4 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("search.label")}
        // Tab 只在面板里循环，不走到背后的页面。
        onKeyDown={(event) => trapTab(event, dialogRef.current)}
        className="contents"
      >
        <SearchPanel
          onClose={onClose}
          onOpenItem={(id) => {
            transferred.current = true;
            onOpenItem(id);
            onClose();
          }}
          commands={commands?.map((command) => ({
            ...command,
            run: () => {
              command.run();
              onClose();
            },
          }))}
          onCreated={(item) => {
            transferred.current = true;
            onOpenItem(item.id);
            onClose();
          }}
          footerExtra={
            global?.registered === true && (
              <span>
                {t("search.globalTip")}
                <kbd className="ml-1 rounded border border-border px-1.5 text-xs">
                  {global.accelerator}
                </kbd>
              </span>
            )
          }
        />
      </div>
    </div>
  );
}
