import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RobotAvatar, SkinSprite } from "@/features/floating";
import { cx } from "@/lib/cx";
import { ANIMATION_SLOTS, hasImageSkin, useSkinStore } from "@/stores/skin-store";
import type { AnimationSlot } from "@/stores/skin-store";

/**
 * 设置页内的桌面伙伴实时动作预览舞台：支持切换模拟状态（待机 / 悬停 / 拖拽 / 拖放 / 完成 / 提醒）。
 */
export function CompanionPreviewStage() {
  const { t } = useTranslation();
  const skin = useSkinStore((state) => state.skin);
  const [slot, setSlot] = useState<AnimationSlot>("idle");
  const hasSkin = hasImageSkin(skin);
  const showRobot = skin.mode === "robot" || (skin.mode === "image" && !hasSkin);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <div
          data-reminder-attention={
            slot === "reminder" && skin.animationEnabled ? "true" : undefined
          }
          className="relative flex h-12 w-24 items-center justify-center rounded-lg border border-border bg-bg p-1"
        >
          {showRobot ? (
            <span className="nv-robot-figure flex h-10 w-13 items-center justify-center">
              <RobotAvatar
                appearance={skin}
                expression={slot}
                action={skin.robotAction}
                animationEnabled={skin.animationEnabled}
                trigger={skin.animationTrigger}
                hovered={slot === "hover"}
              />
            </span>
          ) : (
            <SkinSprite skin={skin} slot={slot} hovered={slot === "hover"} />
          )}
        </div>
        <div
          role="group"
          aria-label={t("settings.companion.animation.preview.label")}
          className="flex max-w-full flex-wrap rounded-md border border-border bg-bg p-0.5"
        >
          {ANIMATION_SLOTS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={slot === option}
              onClick={() => setSlot(option)}
              className={cx(
                "h-7 rounded-sm px-2.5 text-xs transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
                slot === option
                  ? "bg-primary font-medium text-primary-contrast"
                  : "text-muted hover:bg-surface-hover hover:text-text",
              )}
            >
              {t(`settings.companion.animation.slots.${option}`)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
