import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components";
import { ipc } from "@/lib/ipc";
import type { ItemTypeDto } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import { normalizeTitle, resolveKey } from "./model/quick-create";

/** 输入获得焦点后等待多久确认窗口真的拿到了系统焦点（毫秒）。 */
const FOCUS_CHECK_DELAY_MS = 500;

/** [`QuickCreateForm`] 的 Props。 */
export type QuickCreateFormProps = {
  /** 要创建的类型。 */
  kind: ItemTypeDto;
  /** 结束时调用：无论是创建成功、取消、失去焦点还是无法获得焦点。 */
  onDone: () => void;
};

/**
 * 悬浮窗里的快速创建输入行（产品文档 §6.1「先创建，再整理」）。
 *
 * 生命周期与键盘焦点（这是悬浮窗唯一会主动抢焦点的时刻）：
 *
 * 1. 挂载时请求后端 `beginFloatingInput`：记住用户当前的应用、让悬浮窗临时可聚焦并聚焦，
 *    完成后才聚焦输入框；失败（窗口无法聚焦）时提示错误并结束；
 * 2. Enter 创建（输入法组合期间与空标题不提交），Esc 取消；
 * 3. 窗口失去系统焦点（用户点了别处）视为取消；
 * 4. 卸载时（创建成功 / 取消 / 失败都会卸载）请求 `endFloatingInput`，
 *    后端恢复"不可聚焦"并把焦点还给用户之前的应用。
 *
 * 默认值（日期等）由后端决定，前端只提交类型与标题。
 *
 * @param props 类型与结束回调。
 * @returns 输入行。
 */
export function QuickCreateForm({ kind, onDone }: QuickCreateFormProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [isReady, setIsReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 保持 `onDone` 的最新引用，避免把它放进 effect 依赖导致重复申请焦点。 */
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const create = useMutation({
    mutationFn: (value: string) => ipc.quickCreate(kind, value),
    onSuccess: () => onDoneRef.current(),
  });

  // 申请键盘焦点；卸载时无论如何都要归还。
  useEffect(() => {
    let cancelled = false;
    ipc
      .beginFloatingInput()
      .then(() => {
        if (!cancelled) setIsReady(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        reportError(error);
        onDoneRef.current();
      });
    return () => {
      cancelled = true;
      ipc.endFloatingInput().catch(reportError);
    };
  }, []);

  // 输入框在窗口拿到焦点之前是禁用的；启用之后再聚焦它。
  useEffect(() => {
    if (isReady) inputRef.current?.focus();
  }, [isReady]);

  // 获得焦点之后：窗口失去系统焦点就取消；并确认窗口确实拿到了焦点，
  // 否则键盘输入无处可去，用户会被困在一个不响应的输入行里。
  useEffect(() => {
    if (!isReady) return;
    /** 窗口失去系统焦点（用户点了别处）：视为取消。 */
    const handleBlur = () => onDoneRef.current();
    window.addEventListener("blur", handleBlur);
    const check = setTimeout(() => {
      if (!document.hasFocus()) onDoneRef.current();
    }, FOCUS_CHECK_DELAY_MS);
    return () => {
      window.removeEventListener("blur", handleBlur);
      clearTimeout(check);
    };
  }, [isReady]);

  /**
   * 处理按键：Enter 创建，Esc 取消。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const action = resolveKey({
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      title,
    });
    if (action === "submit" && !create.isPending) {
      event.preventDefault();
      create.mutate(normalizeTitle(title));
    } else if (action === "cancel") {
      event.preventDefault();
      onDone();
    }
  }

  return (
    <div className="flex items-center gap-2 border-t border-border px-3 py-2">
      <span className="shrink-0 rounded-sm bg-surface-hover px-1.5 py-0.5 text-xs text-muted">
        {t(`quickCreate.kind.${kind}`)}
      </span>
      <Input
        ref={inputRef}
        aria-label={t("quickCreate.input.label")}
        placeholder={t("quickCreate.input.placeholder")}
        value={title}
        disabled={!isReady || create.isPending}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={handleKeyDown}
        className="h-8"
      />
    </div>
  );
}
