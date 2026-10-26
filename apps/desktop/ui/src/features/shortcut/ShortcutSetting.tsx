import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { cx } from "@/lib/cx";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import type { ShortcutActionDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { useToastStore } from "@/stores/toast-store";
import { useShortcutQuery } from "./api";
import { captureAccelerator } from "./model/accelerator";

/** [`ShortcutSetting`] 的 Props。 */
export type ShortcutSettingProps = {
  /** 设置哪个动作的快捷键，缺省为 Quick Create。 */
  action?: ShortcutActionDto;
  /** 在按钮下方显示注册状态（已生效 / 被占用 / 未生效）；设置页用，侧栏保持紧凑。 */
  showStatus?: boolean;
};

/**
 * 一个全局快捷键的设置（侧栏底部的 Quick Create、设置页的 Quick Create 与全局搜索）：
 * 显示当前绑定，点击后在原地录入新的快捷键并保存。
 *
 * 启动时快捷键被其他程序占用（冲突）时自动展开并说明原因，引导用户直接换一个——
 * 不需要先去找设置页（实施计划 2.6；完整设置页在 3.5）。
 *
 * 录入框是只读输入框：按下组合键即录入，不是输入文字。需要至少一个修饰键，
 * 否则快捷键会吞掉用户正常的输入。保存失败（不合法 / 被占用）时原因显示在框下方，
 * 原来的绑定保持不变。改过的绑定可以在编辑区「恢复默认」。
 *
 * @param props 动作。
 * @returns 快捷键设置区域。
 */
export function ShortcutSetting({
  action = "quickCreate",
  showStatus = false,
}: ShortcutSettingProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const status = useShortcutQuery(action).data;
  /** 当前动作的文案前缀。 */
  const copy = `shortcut.action.${action}`;
  /** 用户是否主动展开 / 收起；`null` 表示跟随状态（冲突时自动展开）。 */
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (accelerator: string) => ipc.setShortcut(action, accelerator),
    // 失败原因显示在录入框下面（不弹全局 Toast），用户可以直接再按一个。
    onError: (error) => setProblem(errorMessage(toAppError(error))),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.shortcut(action), next);
      useToastStore
        .getState()
        .push("success", t(`${copy}.saved`, { accelerator: next.accelerator }));
      close();
    },
  });
  const disable = useMutation({
    mutationFn: () => ipc.disableShortcut(action),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.shortcut(action), next);
      useToastStore.getState().push("success", t(`${copy}.disabled`));
      close();
    },
  });

  if (status === undefined) return null;
  const open = userOpen ?? status.conflict;

  /** 收起编辑区并清掉草稿与提示。 */
  function close(): void {
    setUserOpen(false);
    setDraft(null);
    setProblem(null);
  }

  /**
   * 录入：把按下的组合键变成草稿；只按了修饰键时继续等待，不可用的组合给出原因。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter" && draft !== null) {
      event.preventDefault();
      save.mutate(draft);
      return;
    }
    // Tab 用来离开录入框；没有修饰键的 Tab 不当作快捷键。
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    event.preventDefault();
    const result = captureAccelerator(event.nativeEvent);
    if (result.kind === "accelerator") {
      setDraft(result.text);
      setProblem(null);
    } else if (result.kind === "unusable") {
      setProblem(t(`shortcut.unusable.${result.reason}`));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        aria-expanded={open}
        onClick={() => (open ? close() : setUserOpen(true))}
      >
        {status.registered || status.disabled ? null : (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-danger" />
        )}
        {t(`${copy}.button`, {
          accelerator: status.disabled ? t("shortcut.status.disabled") : status.accelerator,
        })}
      </Button>
      {showStatus && status.registered && status.typesCharacter && (
        <p role="note" className="px-2 text-xs text-danger">
          {t("shortcut.status.typesCharacter", { accelerator: status.accelerator })}
        </p>
      )}
      {showStatus && (
        <p
          className={cx(
            "px-2 text-xs",
            status.registered ? "text-success" : status.conflict ? "text-danger" : "text-muted",
          )}
        >
          {t(
            status.registered
              ? "shortcut.status.registered"
              : status.disabled
                ? "shortcut.status.disabled"
                : status.conflict
                  ? "shortcut.status.conflict"
                  : "shortcut.status.inactive",
          )}
        </p>
      )}
      {open && (
        <div
          role="group"
          aria-label={t(`${copy}.label`)}
          className="flex flex-col gap-2 rounded-md border border-border bg-bg p-2"
        >
          <p className="text-xs text-muted">
            {status.conflict
              ? t(`${copy}.conflict`, { accelerator: status.accelerator })
              : t("shortcut.hint")}
          </p>
          <input
            aria-label={t("shortcut.input")}
            readOnly
            value={draft ?? ""}
            placeholder={t("shortcut.placeholder")}
            onKeyDown={handleKeyDown}
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-center text-sm text-text placeholder:text-muted focus-visible:border-focus"
          />
          {problem !== null && (
            <p role="alert" className="text-xs text-danger">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {status.disabled ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => save.mutate(status.accelerator)}
              >
                {t("shortcut.enable", { accelerator: status.accelerator })}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={disable.isPending}
                onClick={() => disable.mutate()}
              >
                {t("shortcut.disable")}
              </Button>
            )}
            {status.accelerator !== status.defaultAccelerator && (
              <Button
                size="sm"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => save.mutate(status.defaultAccelerator)}
              >
                {t("shortcut.restore", { accelerator: status.defaultAccelerator })}
              </Button>
            )}
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={close}>
              {t("shortcut.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={draft === null || save.isPending}
              onClick={() => draft !== null && save.mutate(draft)}
            >
              {t("shortcut.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
