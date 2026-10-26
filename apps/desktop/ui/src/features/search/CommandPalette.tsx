import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useShortcutQuery } from "@/features/shortcut";
import { SearchPanel } from "./SearchPanel";

/** [`CommandPalette`] 的 Props。 */
export type CommandPaletteProps = {
  /** 关闭面板。 */
  onClose: () => void;
  /** 选中一条结果（回车或点击）；调用后面板自动关闭。 */
  onOpenItem: (id: string) => void;
};

/**
 * 主窗口的搜索浮层（实施计划 3.4，Ctrl+K 打开）：遮罩 + [`SearchPanel`]。
 *
 * * 打开时输入框聚焦，关闭时焦点回到打开之前的元素；
 * * 点击面板外的遮罩关闭；
 * * 底部提示全局搜索的快捷键，让用户知道在其他应用里也能直接搜。
 *
 * @param props 关闭与打开回调。
 * @returns 对话框。
 */
export function CommandPalette({ onClose, onOpenItem }: CommandPaletteProps) {
  const { t } = useTranslation();
  const previouslyFocused = useRef<Element | null>(document.activeElement);
  const global = useShortcutQuery("search").data;

  // 关闭时把焦点还给打开之前的元素。
  useEffect(() => {
    const target = previouslyFocused.current;
    return () => {
      if (target instanceof HTMLElement) target.focus();
    };
  }, []);

  return (
    <div
      className="nv-drop-zone fixed inset-0 z-(--nv-z-dialog) flex items-start justify-center bg-text/30 px-4 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={t("search.label")} className="contents">
        <SearchPanel
          onClose={onClose}
          onOpenItem={(id) => {
            onOpenItem(id);
            onClose();
          }}
          footerExtra={
            global?.registered === true && (
              <span>
                {t("search.globalTip")}
                <kbd className="ml-1 rounded border border-border px-1.5 text-[11px]">
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
