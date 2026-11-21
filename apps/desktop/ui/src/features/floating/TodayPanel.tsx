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
import { useSkinStore } from "@/stores/skin-store";
import { RobotAvatar } from "./RobotAvatar";
import { usePanelDrag } from "./use-panel-drag";

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
  const drag = usePanelDrag();
  const skin = useSkinStore((state) => state.skin);
  const origin = layout === null ? "top right" : `${layout.vertical} ${layout.horizontal}`;
  return (
    // 长按面板的空白处可以拿起整个悬浮窗拖到别处（与长按徽标一样）。
    <section
      aria-label={t("today.panel.label")}
      data-grabbed={drag.selected || undefined}
      {...drag.handlers}
      style={{ transformOrigin: origin }}
      className="nv-panel-in nv-floating-panel relative flex h-full w-full flex-col overflow-hidden"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b-[0.5px] border-border bg-primary/5 px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-base leading-tight font-semibold text-text">
            {t("today.panel.title")}
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted tabular-nums">
            {formatDate(
              view === undefined ? new Date() : parseISO(view.date),
              "monthDayWeekdayShort",
            )}
          </p>
        </div>
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
              variant="secondary"
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
                <rect x="2.25" y="3" width="11.5" height="10" rx="1.5" />
                <path d="M2.25 6.25h11.5M6 6.25V13" />
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
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 py-4 text-center">
          <span className="mb-2 grid size-10 shrink-0 place-items-center rounded-lg bg-surface-hover text-muted">
            <svg
              viewBox="0 0 24 24"
              className="size-5"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
              <path d="M7.5 3.5v4m9-4v4m-13 3h17m-12 5 2 2 4-4" />
            </svg>
          </span>
          <p className="text-sm font-medium text-text">{t("today.empty.title")}</p>
          <p className="text-xs text-muted">{t("today.empty.hint")}</p>
        </div>
      )}
      {quickCreateKind === null ? (
        <footer className="flex shrink-0 flex-wrap items-center gap-1 border-t-[0.5px] border-border bg-bg/60 px-2.5 py-2">
          {QUICK_CREATE_KINDS.map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant={kind === "todo" ? "primary" : "ghost"}
              onClick={() => onQuickCreate(kind)}
            >
              {t(`quickCreate.add.${kind}`)}
            </Button>
          ))}
          {capture !== undefined && (
            <Button size="sm" variant="secondary" className="ml-auto" onClick={capture.onPaste}>
              {t("capture.pasteToInbox")}
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
              {skin.mode === "robot" && zone === "create" && (
                <span className="mb-2 block h-9 w-12">
                  <RobotAvatar appearance={skin} expression="ready" />
                </span>
              )}
              <p
                className={`text-sm font-semibold ${dropZone === zone ? "text-primary" : "text-text"}`}
              >
                {t(`capture.drop.${zone}.title`)}
              </p>
              <p className="text-xs text-muted">
                {t(`capture.drop.${zone}.${dropZone === zone ? "active" : "hint"}`)}
              </p>
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
