import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { CaptureResultDto, ItemDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import { extractCapture, snapshotDrop } from "./model/extract-drop";

/** 「已创建」反馈停留多久后自动消失（毫秒）。 */
export const FEEDBACK_VISIBLE_MS = 6000;

/** 拖放捕获会向悬浮窗状态机投递的事件（悬浮窗状态机事件的子集，避免跨 feature 依赖）。 */
export type DropMachineEvent =
  "dragEnter" | "dragLeave" | "dropped" | "holdRequested" | "holdReleased";

/** 捕获反馈的状态，决定面板里显示什么。 */
export type CaptureFeedback =
  | { status: "saving" }
  | { status: "created"; items: ItemDto[]; undoIds: string[] }
  | { status: "unsupported"; reason: "files" | "empty" }
  | { status: "failed"; message: string };

/** [`useDropCapture`] 的返回值。 */
export type DropCapture = {
  /** 是否有拖拽正悬停在窗口上。 */
  hovering: boolean;
  /** 当前反馈；`null` 表示没有。 */
  feedback: CaptureFeedback | null;
  /** 绑定到窗口根元素的拖放事件处理器。 */
  handlers: {
    onDragEnter: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
  /** 撤销刚才的捕获并关闭反馈。 */
  undo: () => void;
  /** 关闭反馈（「编辑」「知道了」或超时）。 */
  dismiss: () => void;
  /** 暂停 / 恢复自动消失的计时（指针停在反馈上时不该消失）。 */
  pauseDismiss: (paused: boolean) => void;
};

/**
 * 拖放到悬浮窗 → 捕获 → 「已创建 ✓」反馈（实施计划 2.4）。
 *
 * 状态机只负责面板的展开 / 收起：拖入时进入 `dragHover`，松手时请求「保持展开」
 * 直到反馈消失，这样用户能看到结果并撤销，而不是面板在松手瞬间收起。
 * 窗口焦点不受影响：悬浮窗始终不可聚焦，拖放不需要焦点。
 *
 * @param send 向悬浮窗状态机投递事件。
 * @returns 拖放状态与处理器。
 */
export function useDropCapture(send: (event: DropMachineEvent) => void): DropCapture {
  const [hovering, setHovering] = useState(false);
  const [feedback, setFeedback] = useState<CaptureFeedback | null>(null);
  /** dragenter / dragleave 会在子元素之间冒泡，用计数判断是否真的离开了窗口。 */
  const depthRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 反馈代次：只有最新一次捕获的结果才能更新界面（连续拖放时丢弃过期结果）。 */
  const generationRef = useRef(0);
  const undoIdsRef = useRef<string[]>([]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    generationRef.current += 1;
    setFeedback(null);
    send("holdReleased");
  }, [clearTimer, send]);

  const startDismissTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(dismiss, FEEDBACK_VISIBLE_MS);
  }, [clearTimer, dismiss]);

  useEffect(() => clearTimer, [clearTimer]);

  /** 是否是我们关心的拖拽：没有任何可读类型的（如页面内元素拖动）不响应。 */
  const accepts = (event: DragEvent): boolean => event.dataTransfer.types.length > 0;

  /** 拖拽进入窗口：第一次进入时切到拖放悬停状态。 */
  const onDragEnter = (event: DragEvent): void => {
    if (!accepts(event)) return;
    event.preventDefault();
    depthRef.current += 1;
    if (depthRef.current === 1) {
      setHovering(true);
      send("dragEnter");
    }
  };

  /** 拖拽在窗口上移动：取消默认行为以允许放下，并提示是「复制」。 */
  const onDragOver = (event: DragEvent): void => {
    if (!accepts(event)) return;
    // 必须取消默认行为，浏览器才会允许在这里 drop。
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  /** 拖拽离开窗口（计数归零才算真的离开）：回到之前的状态。 */
  const onDragLeave = (event: DragEvent): void => {
    if (!accepts(event)) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) {
      setHovering(false);
      send("dragLeave");
    }
  };

  /** 放下：同步取出快照，请求面板保持展开，异步捕获并显示反馈。 */
  const onDrop = (event: DragEvent): void => {
    if (!accepts(event)) return;
    event.preventDefault();
    // DataTransfer 只在事件回调里有效：先同步取出快照，再做任何异步工作。
    const snapshot = snapshotDrop(event.dataTransfer);
    depthRef.current = 0;
    setHovering(false);
    clearTimer();
    const generation = (generationRef.current += 1);
    send("holdRequested");
    send("dropped");
    setFeedback({ status: "saving" });
    void (async () => {
      /** 显示结果并开始自动消失计时；已被更新的拖放取代时丢弃。 */
      const show = (next: CaptureFeedback): void => {
        if (generationRef.current !== generation) return;
        setFeedback(next);
        startDismissTimer();
      };
      try {
        const extraction = await extractCapture(snapshot);
        if (extraction.kind === "unsupported") {
          show({ status: "unsupported", reason: extraction.reason });
          return;
        }
        const result: CaptureResultDto = await ipc.capture({
          input: extraction.input,
          origin: "drop",
          sourceApplication: null,
        });
        undoIdsRef.current = result.undoIds;
        show({ status: "created", items: result.items, undoIds: result.undoIds });
      } catch (error) {
        show({ status: "failed", message: errorMessage(toAppError(error)) });
      }
    })();
  };

  /** 撤销刚才的捕获：关闭反馈，并删除它创建的全部记录；失败时显示原因。 */
  const undo = (): void => {
    const ids = undoIdsRef.current;
    dismiss();
    if (ids.length === 0) return;
    undoIdsRef.current = [];
    void ipc.undoCapture(ids).catch((error: unknown) => {
      setFeedback({ status: "failed", message: errorMessage(toAppError(error)) });
      send("holdRequested");
      startDismissTimer();
    });
  };

  /** 暂停 / 恢复反馈的自动消失计时。 */
  const pauseDismiss = (paused: boolean): void => {
    if (feedback === null || feedback.status === "saving") return;
    if (paused) clearTimer();
    else startDismissTimer();
  };

  return {
    hovering,
    feedback,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
    undo,
    dismiss,
    pauseDismiss,
  };
}
