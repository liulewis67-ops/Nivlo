import { FRAME_SIZE, MAX_FRAMES, saveImageSourceToAsset } from "@/stores/skin-store";
import type { FrameRef, SkinAssetMeta } from "@/stores/skin-store";

/** 解码出的一帧素材与可选原始停留时长。 */
export type ImportedFrame = {
  asset: SkinAssetMeta;
  durationMs?: number;
};

/** 精灵图切分出的单个单元格区域（像素坐标）。 */
export type SpriteCell = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
};

/**
 * 超出帧数上限时均匀抽帧，返回保留的原始下标（升序、不重复）。
 *
 * @param total 原始总帧数。
 * @param max 允许保留的最大帧数。
 * @returns 抽样后的帧下标数组。
 */
export function sampleFrameIndices(total: number, max: number): number[] {
  if (total <= 0 || max <= 0) return [];
  if (total <= max) return Array.from({ length: total }, (_, i) => i);
  const indices: number[] = [];
  for (let i = 0; i < max; i++) {
    indices.push(Math.floor((i * total) / max));
  }
  return indices;
}

/**
 * 按行列数与跳过末尾帧数计算精灵图的切分区域（行优先顺序）。
 *
 * @param imageWidth 精灵图总宽。
 * @param imageHeight 精灵图总高。
 * @param rows 行数（>= 1）。
 * @param cols 列数（>= 1）。
 * @param skipTrailing 跳过末尾空白帧数（>= 0）。
 * @param maxFrames 最多返回的帧数。
 * @returns 单元格列表。
 */
export function computeSpriteCells(
  imageWidth: number,
  imageHeight: number,
  rows: number,
  cols: number,
  skipTrailing = 0,
  maxFrames = MAX_FRAMES,
): SpriteCell[] {
  const safeRows = Math.max(1, Math.floor(rows));
  const safeCols = Math.max(1, Math.floor(cols));
  const cellW = Math.floor(imageWidth / safeCols);
  const cellH = Math.floor(imageHeight / safeRows);
  if (cellW <= 0 || cellH <= 0) return [];

  const total = Math.max(0, safeRows * safeCols - Math.max(0, Math.floor(skipTrailing)));
  const count = Math.min(total, Math.max(0, maxFrames));
  const cells: SpriteCell[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / safeCols);
    const col = i % safeCols;
    cells.push({
      sx: col * cellW,
      sy: row * cellH,
      sw: cellW,
      sh: cellH,
    });
  }
  return cells;
}

/** 移动轨道中的某一帧到目标下标。 */
export function reorderFrames(frames: readonly FrameRef[], from: number, to: number): FrameRef[] {
  if (from === to || from < 0 || to < 0 || from >= frames.length || to >= frames.length) {
    return [...frames];
  }
  const next = [...frames];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/** 复制指定下标的帧并插到其后面（遵守最大帧数上限）。 */
export function duplicateFrame(
  frames: readonly FrameRef[],
  index: number,
  maxFrames = MAX_FRAMES,
): FrameRef[] {
  const target = frames[index];
  if (!target || frames.length >= maxFrames) return [...frames];
  const next = [...frames];
  next.splice(index + 1, 0, { ...target });
  return next;
}

/** 修改指定下标帧的独立停留时长（`undefined` 表示恢复跟随轨道 FPS）。 */
export function updateFrameDuration(
  frames: readonly FrameRef[],
  index: number,
  durationMs: number | undefined,
): FrameRef[] {
  return frames.map((frame, i) => {
    if (i !== index) return frame;
    if (durationMs === undefined || !Number.isFinite(durationMs)) {
      return { assetId: frame.assetId };
    }
    const clamped = Math.min(10_000, Math.max(16, Math.round(durationMs)));
    return { assetId: frame.assetId, durationMs: clamped };
  });
}

/** 浏览器原生 `ImageDecoder` 的最小类型声明（WebView2 / Chromium 支持）。 */
type BrowserImageDecoder = {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
  decode: (options: { frameIndex: number }) => Promise<{
    image: CanvasImageSource & {
      displayWidth?: number;
      displayHeight?: number;
      codedWidth?: number;
      codedHeight?: number;
      duration?: number | null;
      close: () => void;
    };
  }>;
  close: () => void;
};

/** `ImageDecoder` 构造函数签名。 */
type ImageDecoderCtor = new (init: { data: BufferSource; type: string }) => BrowserImageDecoder;

/**
 * 解码图片文件（GIF / 动态 WebP 自动拆帧并保留每帧时长；其余或不支持 `ImageDecoder` 时取首帧）。
 *
 * @param file 用户选择的图片文件。
 * @param pixel 是否像素风。
 * @param maxFrames 最多提取的帧数。
 * @returns 解码落盘后的帧列表以及是否发生过抽帧裁剪。
 */
export async function importImageFile(
  file: File,
  pixel: boolean,
  maxFrames: number,
): Promise<{ frames: ImportedFrame[]; downsampled: boolean }> {
  const Decoder = (globalThis as unknown as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;
  const isAnimatedCandidate = file.type === "image/gif" || file.type === "image/webp";

  if (Decoder && isAnimatedCandidate && maxFrames > 0) {
    try {
      const buffer = await file.arrayBuffer();
      const decoder = new Decoder({ data: buffer, type: file.type });
      try {
        await decoder.tracks.ready;
        const total = decoder.tracks.selectedTrack?.frameCount ?? 1;
        if (total > 1) {
          const indices = sampleFrameIndices(total, maxFrames);
          const downsampled = total > maxFrames;
          const speedRatio = downsampled ? total / indices.length : 1;
          const imported: ImportedFrame[] = [];

          for (const frameIndex of indices) {
            const { image } = await decoder.decode({ frameIndex });
            try {
              const width = image.displayWidth ?? image.codedWidth ?? FRAME_SIZE;
              const height = image.displayHeight ?? image.codedHeight ?? FRAME_SIZE;
              const asset = await saveImageSourceToAsset(
                Object.assign(image, { width, height }),
                pixel,
              );
              const rawMicros = image.duration;
              const durationMs =
                typeof rawMicros === "number" && rawMicros > 0
                  ? Math.min(10_000, Math.max(16, Math.round((rawMicros / 1000) * speedRatio)))
                  : undefined;
              imported.push(durationMs === undefined ? { asset } : { asset, durationMs });
            } finally {
              image.close();
            }
          }
          return { frames: imported, downsampled };
        }
      } finally {
        decoder.close();
      }
    } catch {
      // ImageDecoder 失败时平滑降级为单帧解码。
    }
  }

  const bitmap = await createImageBitmap(file);
  try {
    const asset = await saveImageSourceToAsset(bitmap, pixel);
    return { frames: [{ asset }], downsampled: false };
  } finally {
    bitmap.close();
  }
}

/**
 * 将精灵图按行列切分并逐格落盘到 `skins/assets/`。
 */
export async function sliceSpriteSheet(
  file: File,
  options: { rows: number; cols: number; skipTrailing: number; pixel: boolean; maxFrames: number },
): Promise<SkinAssetMeta[]> {
  const bitmap = await createImageBitmap(file);
  try {
    const cells = computeSpriteCells(
      bitmap.width,
      bitmap.height,
      options.rows,
      options.cols,
      options.skipTrailing,
      options.maxFrames,
    );
    const assets: SkinAssetMeta[] = [];
    for (const cell of cells) {
      const canvas = document.createElement("canvas");
      canvas.width = cell.sw;
      canvas.height = cell.sh;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("canvas unavailable");
      ctx.imageSmoothingEnabled = !options.pixel;
      ctx.drawImage(bitmap, cell.sx, cell.sy, cell.sw, cell.sh, 0, 0, cell.sw, cell.sh);
      assets.push(await saveImageSourceToAsset(canvas, options.pixel));
    }
    return assets;
  } finally {
    bitmap.close();
  }
}
