import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { CaptureResultDto, ItemDto } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import { extractDraft } from "./model/drop-draft";
import type { DropDraft } from "./model/drop-draft";
import { extractCapture, snapshotDrop } from "./model/extract-drop";
import type { DropSnapshot } from "./model/extract-drop";

/** 「已创建」反馈停留多久后自动消失（毫秒）。 */
export const FEEDBACK_VISIBLE_MS = 6000;

/** 拖放捕获会向悬浮窗状态机投递的事件（悬浮窗状态机事件的子集，避免跨 feature 依赖）。 */
export type DropMachineEvent =
  "dragEnter" | "dragLeave" | "dropped" | "holdRequested" | "holdReleased";

/**
 * 松手的位置决定拖入的内容去哪里：`create` 打开新增配置页并预填，`inbox` 直接收进收集箱。
 * 元素用 `data-drop-zone` 标出区域；不在任何区域里时按 `create` 处理。
 */
export type DropZone = "create" | "inbox";

/** 指针下方的放置区。 */
function zoneOf(target: EventTarget | null): DropZone {
  const element = target instanceof Element ? target.closest("[data-drop-zone]") : null;
  return element?.getAttribute("data-drop-zone") === "inbox" ? "inbox" : "create";
}

/** 拖到可编辑的输入框上：文字交给浏览器插入光标处，不拦截。 */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, [contenteditable='true']") !== null
  );
}

/** 一次捕获的结果：创建成功，或这个来源无法处理。 */
type CaptureOutcome =
  | { kind: "captured"; result: CaptureResultDto }
  | { kind: "unsupported"; reason: "files" | "empty" };

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
  /** 指针当前所在的放置区（只在悬停时有意义）。 */
  zone: DropZone;
  /** 当前反馈；`null` 表示没有。 */
  feedback: CaptureFeedback | null;
  /** 绑定到窗口根元素的拖放事件处理器。 */
  handlers: {
    onDragEnter: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
  /** 读取剪贴板并收进 Inbox（用户点「粘贴」）。 */
  pasteFromClipboard: () => void;
  /** 撤销刚才的捕获并关闭反馈。 */
  undo: () => void;
  /** 关闭反馈（「编辑」「知道了」或超时）。 */
  dismiss: () => void;
  /** 暂停 / 恢复自动消失的计时（指针停在反馈上时不该消失）。 */
  pauseDismiss: (paused: boolean) => void;
};

/**
 * 拖放到悬浮窗：松在「新建事项」区时提取成草稿交给 `onDraft`（打开预填的新增配置页），
 * 松在「直接收进收集箱」区时捕获 → 「已创建 ✓」反馈（实施计划 2.4）。没有 `onDraft` 时一律捕获。
 *
 * 状态机只负责面板的展开 / 收起：拖入时进入 `dragHover`，松手时请求「保持展开」
 * 直到反馈消失，这样用户能看到结果并撤销，而不是面板在松手瞬间收起。
 * 窗口焦点不受影响：悬浮窗始终不可聚焦，拖放不需要焦点。
 *
 * @param send 向悬浮窗状态机投递事件。
 * @param onDraft 拖入内容要新建事项时调用，参数是预填的草稿。
 * @returns 拖放状态与处理器。
 */
export function useDropCapture(
  send: (event: DropMachineEvent) => void,
  onDraft?: (draft: DropDraft) => void,
): DropCapture {
  const [hovering, setHovering] = useState(false);
  const [zone, setZone] = useState<DropZone>("create");
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

  /**
   * 是否是我们关心的拖拽：没有任何可读类型的（如页面内元素拖动）不响应；
   * 文字拖到输入框上交给浏览器插入（文件仍然拦截，避免 WebView 打开它）。
   */
  const accepts = (event: DragEvent): boolean => {
    const types = Array.from(event.dataTransfer.types);
    if (types.length === 0) return false;
    return !(isEditableTarget(event.target) && !types.includes("Files"));
  };

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
    event.dataTransfer.dropEffect =
      onDraft !== undefined && zoneOf(event.target) === "create" ? "link" : "copy";
    setZone(zoneOf(event.target));
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

  /**
   * 执行一次捕获并显示反馈：先请求面板保持展开并显示「正在收集」，结果出来后显示「已创建 / 失败」
   * 并开始自动消失计时。连续触发时只有最新一次的结果会显示（过期的被丢弃）。
   *
   * @param task 真正的捕获；返回创建结果，或「这个来源无法处理」。
   */
  const run = (task: () => Promise<CaptureOutcome>): void => {
    clearTimer();
    const generation = (generationRef.current += 1);
    send("holdRequested");
    setFeedback({ status: "saving" });
    /** 显示结果并开始自动消失计时；已被更新的捕获取代时丢弃。 */
    const show = (next: CaptureFeedback): void => {
      if (generationRef.current !== generation) return;
      setFeedback(next);
      startDismissTimer();
    };
    void (async () => {
      try {
        const outcome = await task();
        if (outcome.kind === "unsupported") {
          show({ status: "unsupported", reason: outcome.reason });
          return;
        }
        undoIdsRef.current = outcome.result.undoIds;
        show({
          status: "created",
          items: outcome.result.items,
          undoIds: outcome.result.undoIds,
        });
      } catch (error) {
        show({ status: "failed", message: errorMessage(toAppError(error)) });
      }
    })();
  };

  /** 收进收集箱：按原来的规则立即创建。 */
  const captureToInbox = (snapshot: DropSnapshot): void => {
    run(async () => {
      const extraction = await extractCapture(snapshot);
      if (extraction.kind === "unsupported") return extraction;
      const result = await ipc.capture({
        input: extraction.input,
        origin: "drop",
        sourceApplication: null,
      });
      return { kind: "captured", result };
    });
  };

  /**
   * 新建事项：提取草稿（可能要等宿主回文件路径），期间面板保持展开并显示「正在读取」；
   * 拿到草稿交给 `onDraft`；只能复制保存的图片改走收集箱；无法处理的给出原因。
   */
  const prepareDraft = (snapshot: DropSnapshot, handle: (draft: DropDraft) => void): void => {
    clearTimer();
    const generation = (generationRef.current += 1);
    send("holdRequested");
    setFeedback({ status: "saving" });
    void (async () => {
      try {
        const outcome = await extractDraft(snapshot);
        if (generationRef.current !== generation) return;
        if (outcome.kind === "inbox") {
          captureToInbox(snapshot);
          return;
        }
        if (outcome.kind === "unsupported") {
          setFeedback({ status: "unsupported", reason: outcome.reason });
          startDismissTimer();
          return;
        }
        // 先进入配置页再释放保持：状态机已在 quickCreate，不会因为释放而收起。
        handle(outcome.draft);
        generationRef.current += 1;
        setFeedback(null);
        send("holdReleased");
      } catch (error) {
        if (generationRef.current !== generation) return;
        setFeedback({ status: "failed", message: errorMessage(toAppError(error)) });
        startDismissTimer();
      }
    })();
  };

  /** 放下：同步取出快照，按放置区新建事项或收进收集箱。 */
  const onDrop = (event: DragEvent): void => {
    if (!accepts(event)) return;
    event.preventDefault();
    // DataTransfer 只在事件回调里有效：先同步取出快照，再做任何异步工作。
    const snapshot = snapshotDrop(event.dataTransfer);
    const target = zoneOf(event.target);
    depthRef.current = 0;
    setHovering(false);
    setZone("create");
    if (onDraft !== undefined && target === "create") prepareDraft(snapshot, onDraft);
    else captureToInbox(snapshot);
    // 先请求保持（在 run / prepareDraft 里），再告诉状态机放下了：面板据此进入展开态而不是回到收起。
    send("dropped");
  };

  /**
   * 粘贴：读取剪贴板（只在用户明确点「粘贴」或按粘贴快捷键时调用）并收进 Inbox。
   * 与拖放共用同一套反馈：已创建 ✓ [撤销] [编辑]。
   */
  const pasteFromClipboard = (): void => {
    run(async () => ({ kind: "captured", result: await ipc.captureFromClipboard() }));
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
    zone,
    feedback,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
    pasteFromClipboard,
    undo,
    dismiss,
    pauseDismiss,
  };
}
