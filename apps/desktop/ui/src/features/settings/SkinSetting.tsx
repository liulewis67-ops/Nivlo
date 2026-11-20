import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { SkinSprite } from "@/features/floating";
import { cx } from "@/lib/cx";
import { reportError } from "@/lib/report-error";
import { MAX_FRAMES, fileToSkinAsset, resolveSkinTrack, useSkinStore } from "@/stores/skin-store";
import type { FrameRef, SkinAssetMeta } from "@/stores/skin-store";
import { useToastStore } from "@/stores/toast-store";

/**
 * 自定义悬浮窗皮肤：选择一组图片 / 像素图落盘为本地帧资源，带预览与逐帧删除。
 *
 * @returns 皮肤上传与预览区。
 */
export function SkinSetting() {
  const { t } = useTranslation();
  const skin = useSkinStore((state) => state.skin);
  const update = useSkinStore((state) => state.update);
  const pruneUnusedAssets = useSkinStore((state) => state.pruneUnusedAssets);
  const inputRef = useRef<HTMLInputElement>(null);

  const idleTrack = skin.tracks.idle;
  const resolvedIdle = resolveSkinTrack(skin, "idle").frames;
  const frameCount = resolvedIdle.length;

  /**
   * 读取所选图片、缩放落盘到 `skins/assets/` 并追加到 `idle` 轨道。
   */
  async function handleFiles(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) return;
    const room = MAX_FRAMES - frameCount;
    if (room <= 0) {
      useToastStore.getState().push("info", t("settings.skin.tooMany", { max: MAX_FRAMES }));
      return;
    }
    try {
      const selected = Array.from(files).slice(0, room);
      const addedAssets: SkinAssetMeta[] = await Promise.all(
        selected.map((file) => fileToSkinAsset(file, skin.pixel)),
      );
      const latest = useSkinStore.getState().skin;
      const nextAssets: Record<string, SkinAssetMeta> = { ...latest.assets };
      const addedRefs: FrameRef[] = [];
      for (const meta of addedAssets) {
        nextAssets[meta.id] = meta;
        addedRefs.push({ assetId: meta.id });
      }
      const existingRefs = latest.tracks.idle?.frames ?? [];
      const playback =
        latest.tracks.idle?.playback ??
        (latest.playback === "pingpong"
          ? "pingpong"
          : latest.playback === "still"
            ? "still"
            : "loop");
      update({
        frames: [],
        assets: nextAssets,
        tracks: {
          ...latest.tracks,
          idle: {
            frames: [...existingRefs, ...addedRefs].slice(0, MAX_FRAMES),
            fps: latest.tracks.idle?.fps ?? latest.fps,
            playback,
          },
        },
      });
      if (files.length > room) {
        useToastStore.getState().push("info", t("settings.skin.tooMany", { max: MAX_FRAMES }));
      }
    } catch (error) {
      reportError(error);
      useToastStore.getState().push("error", t("settings.skin.readFailed"));
    }
  }

  /** 移除指定下标的帧，并清理孤儿本地文件。 */
  function removeFrame(index: number): void {
    if (idleTrack) {
      const nextFrames = idleTrack.frames.filter((_, i) => i !== index);
      const nextTracks = { ...skin.tracks };
      if (nextFrames.length === 0) delete nextTracks.idle;
      else nextTracks.idle = { ...idleTrack, frames: nextFrames };
      update({ tracks: nextTracks });
      void pruneUnusedAssets();
      return;
    }
    update({ frames: skin.frames.filter((_, i) => i !== index) });
  }

  /** 清空全部皮肤帧并清理本地孤儿文件。 */
  function clearAll(): void {
    update({ frames: [], assets: {}, tracks: {} });
    void pruneUnusedAssets();
  }

  return (
    <div className="flex max-w-full flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="nv-float flex h-11 w-20 items-center justify-center rounded-full! px-2 py-1">
          {frameCount > 0 ? (
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
          disabled={frameCount >= MAX_FRAMES}
          onClick={() => inputRef.current?.click()}
        >
          {t("settings.skin.add")}
        </Button>
        <Button size="sm" disabled={frameCount === 0} onClick={clearAll}>
          {t("settings.skin.clear")}
        </Button>
      </div>
      {frameCount > 0 && (
        <ul
          aria-label={t("settings.skin.frames", { count: frameCount })}
          className="flex max-w-72 flex-wrap justify-end gap-1.5"
        >
          {resolvedIdle.map((frame, index) => (
            <li key={`${index}-${frame.assetId ?? frame.src.length}`}>
              <button
                type="button"
                title={t("settings.skin.removeFrame", { index: index + 1 })}
                aria-label={t("settings.skin.removeFrame", { index: index + 1 })}
                onClick={() => removeFrame(index)}
                className="size-8 overflow-hidden rounded-md border border-border bg-bg hover:border-primary"
              >
                <img
                  src={frame.src}
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
