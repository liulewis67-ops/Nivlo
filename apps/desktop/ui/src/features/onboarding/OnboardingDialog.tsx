import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { useShortcutQuery } from "@/features/shortcut";
import { cx } from "@/lib/cx";

/** 引导一共几步。 */
export const ONBOARDING_STEPS = 4;

/** [`OnboardingDialog`] 的 Props。 */
export type OnboardingDialogProps = {
  /** 走完（点「开始使用」）或跳过时调用；两种情况都算看过引导。 */
  onFinish: () => void;
};

/**
 * 一步里的插图：用几块样式化的元素模拟真实界面，不依赖图片资源，随主题自动换色。
 *
 * @param props 步骤序号。
 * @returns 插图元素。
 */
function Illustration({ step }: { step: number }) {
  if (step === 0) {
    return (
      <div className="relative h-36 w-full overflow-hidden rounded-lg border border-border bg-bg">
        <div className="absolute inset-y-0 right-0 flex w-24 items-center justify-center">
          <span className="nv-onboarding-pulse flex size-12 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-contrast shadow-lg">
            {"3"}
          </span>
        </div>
        <p className="absolute top-3 left-4 text-xs text-muted">{"…"}</p>
      </div>
    );
  }
  if (step === 1) {
    return (
      <div className="relative h-36 w-full overflow-hidden rounded-lg border border-border bg-bg">
        <div className="absolute top-3 right-3 w-44 rounded-lg border border-border bg-surface p-2 shadow-md">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="h-2 w-10 rounded bg-text/70" />
            <span className="h-2 w-6 rounded bg-muted/50" />
          </div>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-1.5 py-1">
              <span className="size-3 rounded-[3px] border border-muted" />
              <span className={cx("h-2 rounded bg-text/40", row === 0 ? "w-24" : "w-16")} />
            </div>
          ))}
        </div>
        <span className="absolute right-[4.5rem] bottom-3 rounded-md bg-primary px-2 py-1 text-[10px] text-primary-contrast">
          {"+ 待办"}
        </span>
      </div>
    );
  }
  if (step === 2) {
    return (
      <div className="relative h-36 w-full overflow-hidden rounded-lg border border-border bg-bg">
        <div className="absolute inset-x-8 top-4 bottom-4 flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-primary bg-primary/5">
          <span className="text-2xl" aria-hidden="true">
            {"📥"}
          </span>
          <span className="text-xs text-primary">{"链接 · 文字 · 图片 · 文件"}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="relative h-36 w-full overflow-hidden rounded-lg border border-border bg-bg p-4">
      <div className="rounded-md border border-primary bg-surface px-2 py-1.5 text-sm text-text">
        {"明天下午3点 评审方案"}
        <span className="nv-onboarding-caret ml-0.5 inline-block h-3.5 w-px bg-text align-middle" />
      </div>
      <div className="mt-2 flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs text-text">
        <span aria-hidden="true">{"📅"}</span>
        <span>{"识别到计划：明天 · 周四 15:00"}</span>
      </div>
    </div>
  );
}

/**
 * 首次运行引导（实施计划 7.5）：四步讲清「悬浮窗在哪、悬停与点击、拖入收集、快捷键与自然语言」。
 *
 * * 全键盘：← / → 切换步骤，Enter 下一步 / 完成，Esc 跳过；焦点停留在对话框内；
 * * 步骤指示点可以点击跳转；最后一步的「开始使用」与任何时候的「跳过」都算看过；
 * * 快捷键取自真实的绑定（用户改过就显示改过的），不是写死的文案。
 *
 * @param props 结束回调。
 * @returns 模态对话框。
 */
export function OnboardingDialog({ onFinish }: OnboardingDialogProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const shortcut = useShortcutQuery().data?.accelerator ?? "Ctrl+Shift+Space";
  const primaryRef = useRef<HTMLButtonElement>(null);
  const last = step === ONBOARDING_STEPS - 1;

  // 每次换步，焦点回到主按钮，键盘用户可以连续按 Enter。
  useEffect(() => {
    primaryRef.current?.focus();
  }, [step]);

  /**
   * 键盘：← → 切换步骤，Esc 跳过。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onFinish();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setStep((current) => Math.min(ONBOARDING_STEPS - 1, current + 1));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setStep((current) => Math.max(0, current - 1));
    }
  }

  const body: ReactNode =
    step === 3 ? (
      <>
        {t("onboarding.step3.body", { shortcut })}
        <kbd className="ml-1 rounded border border-border bg-bg px-1.5 py-0.5 text-xs text-text">
          {shortcut}
        </kbd>
      </>
    ) : (
      t(`onboarding.step${step}.body`)
    );

  return (
    <div className="nv-drop-zone fixed inset-0 z-(--nv-z-dialog) flex items-center justify-center bg-text/40 px-4 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("onboarding.label")}
        onKeyDown={handleKeyDown}
        className="nv-panel-in flex w-full max-w-md flex-col gap-5 rounded-xl border border-border bg-surface p-6 shadow-lg"
      >
        <Illustration step={step} />
        <div className="flex min-h-24 flex-col gap-2">
          <h2 className="text-lg font-semibold text-text">{t(`onboarding.step${step}.title`)}</h2>
          <p className="text-sm leading-relaxed text-muted">{body}</p>
        </div>
        <div className="flex items-center justify-between">
          <div
            role="tablist"
            aria-label={t("onboarding.steps")}
            className="flex items-center gap-1.5"
          >
            {Array.from({ length: ONBOARDING_STEPS }, (_, index) => (
              <button
                key={index}
                type="button"
                role="tab"
                aria-selected={index === step}
                aria-label={t("onboarding.goTo", { step: index + 1 })}
                onClick={() => setStep(index)}
                className={cx(
                  "h-2 rounded-full transition-all duration-(--nv-duration-normal) ease-(--nv-ease-standard)",
                  index === step ? "w-6 bg-primary" : "w-2 bg-border hover:bg-muted",
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {!last && (
              <Button size="sm" variant="ghost" onClick={onFinish}>
                {t("onboarding.skip")}
              </Button>
            )}
            {step > 0 && (
              <Button size="sm" onClick={() => setStep(step - 1)}>
                {t("onboarding.back")}
              </Button>
            )}
            <Button
              ref={primaryRef}
              size="sm"
              variant="primary"
              onClick={() => (last ? onFinish() : setStep(step + 1))}
            >
              {last ? t("onboarding.start") : t("onboarding.next")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
