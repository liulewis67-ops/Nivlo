import { parseISO } from "date-fns";
import { formatDate } from "@/lib/date-format";
import { useTranslation } from "react-i18next";
import { Button, Tooltip, LoadFeedback } from "@/components";
import { CaptureFeedbackBar } from "@/features/capture";
import type { CaptureFeedback, DropZone } from "@/features/capture";
import { useInboxCountQuery } from "@/features/inbox";
import { QuickCreateForm } from "@/features/quick-create";
import { TodayBoard, useTodayQuery } from "@/features/today";
import type { ExpandedLayoutDto, ItemTypeDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";

/** [`TodayPanel`] 的 Props。 */
export type TodayPanelProps = {
  /** 展开方向：面板从徽标所在的角"长出来"，据此设置动画的 transform-origin；展开完成前为 `null`。 */
  layout: ExpandedLayoutDto | null;
  /** 正在快速创建的类型；`null` 表示没有在创建，底部显示三个添加按钮。 */
  quickCreateKind: ItemTypeDto | null;
  /** 点击 `+ 待办` / `+ 笔记` / `+ 提示` 时调用。 */
  onQuickCreate: (kind: ItemTypeDto) => void;
  /** 快速创建的可见类型组改变选择。 */
  onQuickCreateKindChange?: ((kind: ItemTypeDto) => void) | undefined;
  /** 快速创建结束（成功、取消或失败）时调用。 */
  onQuickCreateDone: () => void;
  /** 是否有拖拽悬停在面板上：显示「新建事项」「直接收进收集箱」两个放置区。 */
  dropActive?: boolean;
  /** 指针当前所在的放置区，用来高亮。 */
  dropZone?: DropZone;
  /** 捕获反馈（「已创建 ✓ 撤销 编辑」）与它的操作；没有反馈时 `feedback` 为 `null`。 */
  capture?: {
    feedback: CaptureFeedback | null;
    onUndo: () => void;
    onEdit: () => void;
    onDismiss: () => void;
    onHoldChange: (held: boolean) => void;
    /** 点「粘贴」：读取剪贴板并收进 Inbox。 */
    onPaste: () => void;
  };
};

/** 底部添加按钮对应的类型，按展示顺序排列。 */
const QUICK_CREATE_KINDS: ItemTypeDto[] = ["todo", "note", "tip"];

/**
 * 悬浮窗展开后的 Today 面板。
 *
 * 标题、Today 列表（只读缓存，Hover 展开不取数）与底部的快速创建。完成 / 撤销（1.6）；排序、推迟在
 * 实施计划 1.7、1.8 加入。
 *
 * @param props 展开方向。
 * @returns 面板元素。
 */
export function TodayPanel({
  layout,
  quickCreateKind,
  onQuickCreate,
  onQuickCreateKindChange,
  onQuickCreateDone,
  dropActive = false,
  dropZone = "create",
  capture,
}: TodayPanelProps) {
  const { t } = useTranslation();
  const today = useTodayQuery();
  const view = today.data;
  const inboxCount = useInboxCountQuery().data ?? 0;
  const origin = layout === null ? "top right" : `${layout.vertical} ${layout.horizontal}`;
  return (
    <section
      aria-label={t("today.panel.label")}
      style={{ transformOrigin: origin }}
      className="nv-panel-in nv-float relative flex h-full w-full flex-col overflow-hidden"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        {/* 面板只有 300px：用短日期、不换行（英文的「Tuesday, Oct 27」会把「27」挤到第二行），放不下时截断。 */}
        <h2 className="min-w-0 truncate text-sm font-semibold whitespace-nowrap text-text">
          {t("today.panel.title")}
          <span className="ml-2 font-normal text-muted">
            {formatDate(
              view === undefined ? new Date() : parseISO(view.date),
              "monthDayWeekdayShort",
            )}
          </span>
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {inboxCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void ipc.openMainAt("inbox")}>
              {t("today.panel.inbox", { count: inboxCount })}
            </Button>
          )}
          {/* 图标按钮：「打开主窗口」的文字（尤其英文）会把日期挤掉；点徽标同样能打开主窗口，这里只是捷径。 */}
          <Tooltip content={t("today.panel.openMain")}>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("today.panel.openMain")}
              onClick={() => void ipc.openMain()}
            >
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9.5 2.5h4v4M13.5 2.5 8 8M7 3.5H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9" />
              </svg>
            </Button>
          </Tooltip>
        </div>
      </header>
      <LoadFeedback
        loading={today.isLoading}
        failed={today.isError}
        onRetry={() => void today.refetch()}
      />
      {view === undefined ? null : view.todos.length > 0 ||
        view.tips.length > 0 ||
        view.completed.length > 0 ? (
        <TodayBoard view={view} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-center">
          <p className="text-sm font-medium text-text">{t("today.empty.title")}</p>
          <p className="text-xs text-muted">{t("today.empty.hint")}</p>
        </div>
      )}
      {quickCreateKind === null ? (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          {QUICK_CREATE_KINDS.map((kind) => (
            <Button key={kind} size="sm" variant="ghost" onClick={() => onQuickCreate(kind)}>
              {t(`quickCreate.add.${kind}`)}
            </Button>
          ))}
          {capture !== undefined && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={capture.onPaste}>
              {t("capture.paste")}
            </Button>
          )}
        </footer>
      ) : (
        <QuickCreateForm
          kind={quickCreateKind}
          onKindChange={onQuickCreateKindChange}
          onPasteNonText={capture?.onPaste}
          today={view?.date}
          onDone={onQuickCreateDone}
        />
      )}
      {dropActive && (
        // 两个放置区：松手的位置决定去向。区域之外（边缘）按「新建事项」处理，见 use-drop-capture。
        <div
          role="group"
          aria-label={t("capture.drop.label")}
          className="nv-drop-zone absolute inset-0 flex flex-col gap-2 rounded-[inherit] bg-surface p-2"
        >
          {(["create", "inbox"] as const).map((zone) => (
            <div
              key={zone}
              data-drop-zone={zone}
              data-active={dropZone === zone}
              className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-3 text-center transition-colors ${
                zone === "create" ? "flex-1" : "h-20 shrink-0"
              } ${dropZone === zone ? "border-primary bg-primary/10" : "border-border bg-surface"}`}
            >
              <p
                className={`text-sm font-semibold ${dropZone === zone ? "text-primary" : "text-text"}`}
              >
                {t(`capture.drop.${zone}.title`)}
              </p>
              <p className="text-xs text-muted">{t(`capture.drop.${zone}.hint`)}</p>
            </div>
          ))}
        </div>
      )}
      {capture?.feedback != null && !dropActive && (
        <CaptureFeedbackBar
          feedback={capture.feedback}
          onUndo={capture.onUndo}
          onEdit={capture.onEdit}
          onDismiss={capture.onDismiss}
          onHoldChange={capture.onHoldChange}
        />
      )}
    </section>
  );
}
