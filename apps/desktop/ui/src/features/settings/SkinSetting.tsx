import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { SkinSprite } from "@/features/floating";
import { cx } from "@/lib/cx";
import { reportError } from "@/lib/report-error";
import { MAX_FRAMES, fileToFrame, useSkinStore } from "@/stores/skin-store";
import { useToastStore } from "@/stores/toast-store";

/**
 * 自定义悬浮窗皮肤：选择一组图片 / 像素图作为动画帧，带预览与逐帧删除。
 *
 * 图片会被缩小到 96px 以内再保存，GIF 只取第一帧（多张图片按选择顺序成为多帧）。
 *
 * @returns 皮肤上传与预览区。
 */
export function SkinSetting() {
  const { t } = useTranslation();
  const skin = useSkinStore((state) => state.skin);
  const update = useSkinStore((state) => state.update);
  const reset = useSkinStore((state) => state.reset);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * 读取所选图片并追加为新帧。
   *
   * @param files 文件选择器返回的文件。
   */
  async function handleFiles(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) return;
    const room = MAX_FRAMES - skin.frames.length;
    try {
      const added = await Promise.all(
        Array.from(files)
          .slice(0, room)
          .map((file) => fileToFrame(file, skin.pixel)),
      );
      if (!update({ frames: [...skin.frames, ...added] })) {
        useToastStore.getState().push("error", t("settings.skin.saveFailed"));
      } else if (files.length > room) {
        useToastStore.getState().push("info", t("settings.skin.tooMany", { max: MAX_FRAMES }));
      }
    } catch (error) {
      reportError(error);
      useToastStore.getState().push("error", t("settings.skin.readFailed"));
    }
  }

  return (
    <div className="flex max-w-full flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="nv-float flex h-11 w-20 items-center justify-center rounded-full! px-2 py-1">
          {skin.frames.length > 0 ? (
            <SkinSprite skin={skin} hovered />
          ) : (
            <span className="text-xs text-muted">{t("settings.skin.empty")}</span>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          aria-label={t("settings.skin.add")}
          onChange={(event) => {
            void handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <Button
          size="sm"
          disabled={skin.frames.length >= MAX_FRAMES}
          onClick={() => inputRef.current?.click()}
        >
          {t("settings.skin.add")}
        </Button>
        <Button size="sm" disabled={skin.frames.length === 0} onClick={reset}>
          {t("settings.skin.clear")}
        </Button>
      </div>
      {skin.frames.length > 0 && (
        <ul
          aria-label={t("settings.skin.frames", { count: skin.frames.length })}
          className="flex max-w-72 flex-wrap justify-end gap-1.5"
        >
          {skin.frames.map((frame, index) => (
            <li key={`${index}-${frame.length}`}>
              <button
                type="button"
                title={t("settings.skin.removeFrame", { index: index + 1 })}
                aria-label={t("settings.skin.removeFrame", { index: index + 1 })}
                onClick={() => update({ frames: skin.frames.filter((_, i) => i !== index) })}
                className="size-8 overflow-hidden rounded-md border border-border bg-bg hover:border-primary"
              >
                <img
                  src={frame}
                  role="presentation"
                  className={cx(
                    "size-full object-contain",
                    skin.pixel && "[image-rendering:pixelated]",
                  )}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
