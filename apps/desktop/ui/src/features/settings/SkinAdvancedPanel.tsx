import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import { reportError } from "@/lib/report-error";
import {
  ANIMATION_SLOTS,
  MAX_FPS,
  MIN_FPS,
  TRACK_PLAYBACKS,
  collectReferencedAssetFiles,
  sanitizeSkin,
  useSkinStore,
} from "@/stores/skin-store";
import type { AnimationSlot } from "@/stores/skin-store";
import { useToastStore } from "@/stores/toast-store";
import { SkinSetting } from "./SkinSetting";

/** 把字节数格式化为易读的 B / KB / MB。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 分状态自定义轨道编辑器：允许为 `idle / hover / grabbed / ready / done / reminder` 分别配置帧与播放参数。
 */
export function SkinTracksEditor() {
  const { t } = useTranslation();
  const skin = useSkinStore((state) => state.skin);
  const update = useSkinStore((state) => state.update);
  const [slot, setSlot] = useState<AnimationSlot>("idle");
  const activeTrack = skin.tracks[slot];

  return (
    <div className="flex w-full flex-col gap-3">
      <div
        role="tablist"
        aria-label={t("settings.skin.tracks.toggle")}
        className="flex flex-wrap gap-1 rounded-md border border-border bg-bg p-1"
      >
        {ANIMATION_SLOTS.map((option) => {
          const count = skin.tracks[option]?.frames.length ?? 0;
          const active = slot === option;
          return (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSlot(option)}
              className={cx(
                "flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs transition-colors duration-(--nv-duration-fast)",
                active
                  ? "bg-primary font-medium text-primary-contrast"
                  : "text-muted hover:bg-surface-hover hover:text-text",
              )}
            >
              <span>{t(`settings.companion.animation.slots.${option}`)}</span>
              <span className="text-[11px] opacity-80 tabular-nums">
                {count > 0 ? count : option === "idle" ? 0 : t("settings.skin.tracks.inheritsIdle")}
              </span>
            </button>
          );
        })}
      </div>

      <SkinSetting slot={slot} />

      {activeTrack && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-bg px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">
              {t("settings.skin.tracks.trackPlayback.label")}
            </span>
            <div
              role="group"
              aria-label={t("settings.skin.tracks.trackPlayback.label")}
              className="flex rounded-md border border-border bg-surface p-0.5"
            >
              {TRACK_PLAYBACKS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={activeTrack.playback === option}
                  onClick={() =>
                    update({
                      tracks: {
                        ...skin.tracks,
                        [slot]: { ...activeTrack, playback: option },
                      },
                    })
                  }
                  className={cx(
                    "h-6 rounded-sm px-2 text-xs transition-colors duration-(--nv-duration-fast)",
                    activeTrack.playback === option
                      ? "bg-primary font-medium text-primary-contrast"
                      : "text-muted hover:bg-surface-hover hover:text-text",
                  )}
                >
                  {t(`settings.skin.tracks.trackPlayback.${option}`)}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted">
            <span>{t("settings.skin.tracks.trackFps")}</span>
            <input
              type="range"
              min={MIN_FPS}
              max={MAX_FPS}
              step={1}
              value={activeTrack.fps}
              onChange={(event) =>
                update({
                  tracks: {
                    ...skin.tracks,
                    [slot]: { ...activeTrack, fps: Number(event.target.value) },
                  },
                })
              }
              className="w-24 accent-(--nv-primary)"
            />
            <span className="w-6 text-right tabular-nums">{activeTrack.fps}</span>
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * 本地皮肤资源占用统计、孤儿文件清理与 `.stardeskbox-skin.zip` 皮肤包导入/导出控件。
 */
export function SkinStorageControls() {
  const { t } = useTranslation();
  const skin = useSkinStore((state) => state.skin);
  const update = useSkinStore((state) => state.update);
  const pruneUnusedAssets = useSkinStore((state) => state.pruneUnusedAssets);
  const [busy, setBusy] = useState(false);

  const assetCount = Object.keys(skin.assets).length;
  const usageQuery = useQuery({
    queryKey: ["skinStorageUsage", assetCount],
    queryFn: () => ipc.getSkinStorageUsage(),
    meta: { errorPresentation: "inline" },
  });
  const usage = usageQuery.data ?? null;

  /** 清理未被引用的本地皮肤帧图。 */
  async function handlePrune(): Promise<void> {
    setBusy(true);
    try {
      const freed = await pruneUnusedAssets();
      await usageQuery.refetch();
      useToastStore
        .getState()
        .push(
          "info",
          freed > 0
            ? t("settings.skin.storage.pruned", { freed: formatBytes(freed) })
            : t("settings.skin.storage.prunedNone"),
        );
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  /** 将当前皮肤清单与帧图导出为 `.stardeskbox-skin.zip`。 */
  async function handleExport(): Promise<void> {
    setBusy(true);
    try {
      const latest = useSkinStore.getState().skin;
      const files = collectReferencedAssetFiles(latest);
      const path = await ipc.exportSkinPack(JSON.stringify(latest, null, 2), files);
      useToastStore.getState().push("info", t("settings.skin.storage.exported", { path }));
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  /** 导入 `.stardeskbox-skin.zip` 皮肤包。 */
  async function handleImport(): Promise<void> {
    setBusy(true);
    try {
      const json = await ipc.importSkinPack();
      if (json === null) return;
      const imported = sanitizeSkin(JSON.parse(json));
      update(imported);
      await usageQuery.refetch();
      useToastStore.getState().push("info", t("settings.skin.storage.imported"));
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {usage !== null && (
        <span className="text-xs text-muted tabular-nums">
          {t("settings.skin.storage.usage", {
            count: usage.fileCount,
            used: formatBytes(usage.totalBytes),
            quota: formatBytes(usage.quotaBytes),
          })}
        </span>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" disabled={busy} onClick={() => void handlePrune()}>
          {t("settings.skin.storage.prune")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void handleExport()}>
          {t("settings.skin.storage.export")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void handleImport()}>
          {t("settings.skin.storage.import")}
        </Button>
      </div>
    </div>
  );
}
