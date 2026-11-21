import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { cx } from "@/lib/cx";
import { computeSpriteCells } from "./model/frame-import";

/** [`SpriteSheetDialog`] 的 Props。 */
type SpriteSheetDialogProps = {
  file: File;
  pixel: boolean;
  maxFrames: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (options: { rows: number; cols: number; skipTrailing: number }) => void;
};

/**
 * 精灵图网格切帧面板：实时预览行列网格线与预计帧数，确认后批量切片导入。
 */
export function SpriteSheetDialog({
  file,
  pixel,
  maxFrames,
  busy,
  onCancel,
  onConfirm,
}: SpriteSheetDialogProps) {
  const { t } = useTranslation();
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [rows, setRows] = useState(1);
  const [cols, setCols] = useState(4);
  const [skipTrailing, setSkipTrailing] = useState(0);

  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

  const maxSkip = Math.max(0, rows * cols - 1);
  const safeSkip = Math.min(skipTrailing, maxSkip);
  const cells =
    dimensions.width > 0 && dimensions.height > 0
      ? computeSpriteCells(dimensions.width, dimensions.height, rows, cols, safeSkip, maxFrames)
      : [];
  const firstCell = cells[0];

  return (
    <div
      role="region"
      aria-label={t("settings.skin.sheet.title")}
      className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-bg p-3"
    >
      <p className="text-xs font-semibold text-text">{t("settings.skin.sheet.title")}</p>
      {previewUrl && (
        <div className="relative flex max-h-44 items-center justify-center overflow-hidden rounded-md border border-border bg-surface p-2">
          <div className="relative inline-block max-h-40 max-w-full">
            <img
              src={previewUrl}
              alt={file.name}
              onLoad={(event) => {
                setDimensions({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
              className={cx(
                "block max-h-40 max-w-full object-contain",
                pixel && "[image-rendering:pixelated]",
              )}
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 grid"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
              }}
            >
              {Array.from({ length: rows * cols }).map((_, idx) => {
                const skipped = idx >= rows * cols - safeSkip;
                return (
                  <span
                    key={idx}
                    className={cx("border border-primary/60", skipped && "bg-danger/25")}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t("settings.skin.sheet.rows")}
          <input
            type="number"
            min={1}
            max={16}
            value={rows}
            onChange={(event) =>
              setRows(Math.min(16, Math.max(1, Number(event.target.value) || 1)))
            }
            className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-text tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t("settings.skin.sheet.cols")}
          <input
            type="number"
            min={1}
            max={16}
            value={cols}
            onChange={(event) =>
              setCols(Math.min(16, Math.max(1, Number(event.target.value) || 1)))
            }
            className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-text tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t("settings.skin.sheet.skipTrailing")}
          <input
            type="number"
            min={0}
            max={maxSkip}
            value={safeSkip}
            onChange={(event) =>
              setSkipTrailing(Math.min(maxSkip, Math.max(0, Number(event.target.value) || 0)))
            }
            className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-text tabular-nums"
          />
        </label>
      </div>
      {firstCell && (
        <p className="text-xs text-muted">
          {t("settings.skin.sheet.summary", {
            count: cells.length,
            width: firstCell.sw,
            height: firstCell.sh,
          })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel} disabled={busy}>
          {t("settings.skin.sheet.cancel")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || cells.length === 0}
          onClick={() => onConfirm({ rows, cols, skipTrailing: safeSkip })}
        >
          {t("settings.skin.sheet.confirm")}
        </Button>
      </div>
    </div>
  );
}
