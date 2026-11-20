import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { SkinSprite } from "@/features/floating";
import { cx } from "@/lib/cx";
import { reportError } from "@/lib/report-error";
import {
  MAX_FRAMES,
  MAX_TOTAL_FRAMES,
  countTotalTrackFrames,
  skinAssetUrl,
  useSkinStore,
} from "@/stores/skin-store";
import type { AnimationSlot, FrameRef, SkinAssetMeta } from "@/stores/skin-store";
import { useToastStore } from "@/stores/toast-store";
import {
  duplicateFrame,
  importImageFile,
  reorderFrames,
  sliceSpriteSheet,
  updateFrameDuration,
} from "./model/frame-import";
import { SpriteSheetDialog } from "./SpriteSheetDialog";

/** [`SkinSetting`] 的 Props。 */
type SkinSettingProps = {
  /** 要编辑的状态槽位；默认编辑 `idle`。 */
  slot?: AnimationSlot;
};

/**
 * 自定义悬浮窗皮肤编辑器：
 * - 多图与 GIF / 动态 WebP 自动拆帧导入；
 * - 精灵图（Sprite Sheet）网格切帧导入；
 * - 帧拖拽排序、左右移动、复制、删除与单帧停留时长编辑。
 */
export function SkinSetting({ slot = "idle" }: SkinSettingProps = {}) {
  const { t } = useTranslation();
  const skin = useSkinStore((state) => state.skin);
  const update = useSkinStore((state) => state.update);
  const pruneUnusedAssets = useSkinStore((state) => state.pruneUnusedAssets);
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetInputRef = useRef<HTMLInputElement>(null);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [sheetFile, setSheetFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const track = skin.tracks[slot];
  const trackFrames: FrameRef[] = track?.frames ?? [];
  const legacyFrames = slot === "idle" && trackFrames.length === 0 ? skin.frames : [];
  const frameCount = trackFrames.length > 0 ? trackFrames.length : legacyFrames.length;
  const totalFrames = countTotalTrackFrames(skin);
  const remainingRoom = Math.min(MAX_FRAMES - frameCount, MAX_TOTAL_FRAMES - totalFrames);

  /** 将修改后的帧列表写回当前槽位轨道。 */
  function commitTrackFrames(
    nextFrames: FrameRef[],
    extraAssets?: Record<string, SkinAssetMeta>,
  ): void {
    const latest = useSkinStore.getState().skin;
    const nextTracks = { ...latest.tracks };
    if (nextFrames.length === 0) {
      delete nextTracks[slot];
    } else {
      const existing = latest.tracks[slot];
      const fallbackPlayback =
        slot === "done"
          ? "once"
          : latest.playback === "pingpong"
            ? "pingpong"
            : latest.playback === "still"
              ? "still"
              : "loop";
      nextTracks[slot] = {
        frames: nextFrames.slice(0, MAX_FRAMES),
        fps: existing?.fps ?? latest.fps,
        playback: existing?.playback ?? fallbackPlayback,
      };
    }
    update({
      ...(slot === "idle" ? { frames: [] } : {}),
      assets: extraAssets ? { ...latest.assets, ...extraAssets } : latest.assets,
      tracks: nextTracks,
    });
  }

  /** 读取所选图片或动图并追加到当前轨道。 */
  async function handleFiles(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) return;
    if (remainingRoom <= 0) {
      useToastStore.getState().push("info", t("settings.skin.tooMany", { max: MAX_FRAMES }));
      return;
    }
    setBusy(true);
    try {
      let budget = remainingRoom;
      let anyDownsampled = false;
      let anyTruncated = false;
      const addedAssets: Record<string, SkinAssetMeta> = {};
      const addedRefs: FrameRef[] = [];

      for (const file of Array.from(files)) {
        if (budget <= 0) {
          anyTruncated = true;
          break;
        }
        const decoded = await importImageFile(file, skin.pixel, budget);
        if (decoded.downsampled) anyDownsampled = true;
        for (const item of decoded.frames) {
          addedAssets[item.asset.id] = item.asset;
          addedRefs.push(
            item.durationMs === undefined
              ? { assetId: item.asset.id }
              : { assetId: item.asset.id, durationMs: item.durationMs },
          );
          budget -= 1;
        }
      }

      const latestTrack = useSkinStore.getState().skin.tracks[slot]?.frames ?? [];
      commitTrackFrames([...latestTrack, ...addedRefs], addedAssets);

      if (anyDownsampled) {
        useToastStore.getState().push("info", t("settings.skin.downsampled", { max: MAX_FRAMES }));
      } else if (anyTruncated) {
        useToastStore.getState().push("info", t("settings.skin.tooMany", { max: MAX_FRAMES }));
      }
    } catch (error) {
      reportError(error);
      useToastStore.getState().push("error", t("settings.skin.readFailed"));
    } finally {
      setBusy(false);
    }
  }

  /** 切分精灵图并追加到当前轨道。 */
  async function handleConfirmSheet(options: {
    rows: number;
    cols: number;
    skipTrailing: number;
  }): Promise<void> {
    if (sheetFile === null || remainingRoom <= 0) return;
    setBusy(true);
    try {
      const assets = await sliceSpriteSheet(sheetFile, {
        ...options,
        pixel: skin.pixel,
        maxFrames: remainingRoom,
      });
      const addedAssets: Record<string, SkinAssetMeta> = {};
      const addedRefs: FrameRef[] = [];
      for (const asset of assets) {
        addedAssets[asset.id] = asset;
        addedRefs.push({ assetId: asset.id });
      }
      const latestTrack = useSkinStore.getState().skin.tracks[slot]?.frames ?? [];
      commitTrackFrames([...latestTrack, ...addedRefs], addedAssets);
      setSheetFile(null);
    } catch (error) {
      reportError(error);
      useToastStore.getState().push("error", t("settings.skin.readFailed"));
    } finally {
      setBusy(false);
    }
  }

  /** 移除指定下标的帧并清理孤儿本地文件。 */
  function removeFrame(index: number): void {
    if (trackFrames.length > 0) {
      commitTrackFrames(trackFrames.filter((_, i) => i !== index));
      setSelectedIndex((prev) =>
        prev === index ? null : prev !== null && prev > index ? prev - 1 : prev,
      );
      void pruneUnusedAssets();
      return;
    }
    update({ frames: skin.frames.filter((_, i) => i !== index) });
  }

  /** 清空当前槽位帧。 */
  function clearTrack(): void {
    if (slot === "idle" && Object.keys(skin.tracks).length <= 1) {
      update({ frames: [], assets: {}, tracks: {} });
    } else {
      commitTrackFrames([]);
    }
    setSelectedIndex(null);
    void pruneUnusedAssets();
  }

  const activeSelected = selectedIndex !== null ? (trackFrames[selectedIndex] ?? null) : null;

  return (
    <div className="flex max-w-full flex-col items-start gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="nv-float flex h-11 w-20 items-center justify-center rounded-full! px-2 py-1">
          {frameCount > 0 ? (
            <SkinSprite skin={skin} slot={slot} hovered />
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
        <input
          ref={sheetInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-label={t("settings.skin.spriteSheet")}
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            if (picked !== null) setSheetFile(picked);
            event.target.value = "";
          }}
        />
        <Button
          size="sm"
          disabled={busy || remainingRoom <= 0}
          onClick={() => inputRef.current?.click()}
        >
          {t("settings.skin.add")}
        </Button>
        <Button
          size="sm"
          disabled={busy || remainingRoom <= 0}
          onClick={() => sheetInputRef.current?.click()}
        >
          {t("settings.skin.spriteSheet")}
        </Button>
        <Button size="sm" disabled={busy || frameCount === 0} onClick={clearTrack}>
          {t("settings.skin.clear")}
        </Button>
      </div>

      {sheetFile && (
        <SpriteSheetDialog
          file={sheetFile}
          pixel={skin.pixel}
          maxFrames={Math.max(1, remainingRoom)}
          busy={busy}
          onCancel={() => setSheetFile(null)}
          onConfirm={(options) => void handleConfirmSheet(options)}
        />
      )}

      {frameCount > 0 && (
        <ul
          aria-label={t("settings.skin.frames", { count: frameCount })}
          className="flex max-w-md flex-wrap gap-1.5"
        >
          {trackFrames.length > 0
            ? trackFrames.map((frame, index) => {
                const meta = skin.assets[frame.assetId];
                if (!meta) return null;
                const isSelected = selectedIndex === index;
                return (
                  <li
                    key={`${index}-${frame.assetId}`}
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null && dragIndex !== index) {
                        commitTrackFrames(reorderFrames(trackFrames, dragIndex, index));
                        setSelectedIndex(index);
                      }
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    <button
                      type="button"
                      title={t("settings.skin.selectFrame", { index: index + 1 })}
                      aria-label={t("settings.skin.selectFrame", { index: index + 1 })}
                      aria-pressed={isSelected}
                      onClick={() => setSelectedIndex(isSelected ? null : index)}
                      className={cx(
                        "relative size-9 overflow-hidden rounded-md border bg-bg",
                        isSelected
                          ? "border-primary ring-1 ring-primary"
                          : "border-border hover:border-primary",
                      )}
                    >
                      <img
                        src={skinAssetUrl(meta)}
                        role="presentation"
                        className={cx(
                          "size-full object-contain",
                          skin.pixel && "[image-rendering:pixelated]",
                        )}
                      />
                      {frame.durationMs !== undefined && (
                        <span className="absolute right-0 bottom-0 rounded-tl bg-bg/85 px-0.5 text-[9px] leading-tight text-muted tabular-nums">
                          {frame.durationMs}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })
            : legacyFrames.map((frame, index) => (
                <li key={`${index}-${frame.length}`}>
                  <button
                    type="button"
                    title={t("settings.skin.removeFrame", { index: index + 1 })}
                    aria-label={t("settings.skin.removeFrame", { index: index + 1 })}
                    onClick={() => removeFrame(index)}
                    className="size-9 overflow-hidden rounded-md border border-border bg-bg hover:border-primary"
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

      {activeSelected !== null && selectedIndex !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-2">
          <Button
            size="sm"
            disabled={selectedIndex <= 0}
            onClick={() => {
              commitTrackFrames(reorderFrames(trackFrames, selectedIndex, selectedIndex - 1));
              setSelectedIndex(selectedIndex - 1);
            }}
          >
            {t("settings.skin.moveLeft")}
          </Button>
          <Button
            size="sm"
            disabled={selectedIndex >= trackFrames.length - 1}
            onClick={() => {
              commitTrackFrames(reorderFrames(trackFrames, selectedIndex, selectedIndex + 1));
              setSelectedIndex(selectedIndex + 1);
            }}
          >
            {t("settings.skin.moveRight")}
          </Button>
          <Button
            size="sm"
            disabled={remainingRoom <= 0}
            onClick={() => {
              commitTrackFrames(duplicateFrame(trackFrames, selectedIndex, MAX_FRAMES));
              setSelectedIndex(selectedIndex + 1);
            }}
          >
            {t("settings.skin.duplicateFrame")}
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <span>{t("settings.skin.frameDuration")}</span>
            <input
              type="number"
              min={16}
              max={10000}
              step={10}
              placeholder={t("settings.skin.frameDurationPlaceholder")}
              value={activeSelected.durationMs ?? ""}
              onChange={(event) => {
                const raw = event.target.value.trim();
                const value = raw === "" ? undefined : Number(raw);
                commitTrackFrames(updateFrameDuration(trackFrames, selectedIndex, value));
              }}
              className="h-7 w-20 rounded-md border border-border bg-surface px-1.5 text-xs text-text tabular-nums"
            />
          </label>
          <Button size="sm" onClick={() => removeFrame(selectedIndex)}>
            {t("settings.skin.removeFrame", { index: selectedIndex + 1 })}
          </Button>
        </div>
      )}
    </div>
  );
}
