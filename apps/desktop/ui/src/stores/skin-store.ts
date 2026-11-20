import { create } from "zustand";
import { ipc, isRunningInTauri } from "@/lib/ipc";
import {
  ANIMATION_SLOTS,
  ANIMATION_TRIGGERS,
  TRACK_PLAYBACKS,
} from "@/features/floating/model/frame-timeline";
import type {
  AnimationSlot,
  AnimationTrigger,
  TrackPlayback,
} from "@/features/floating/model/frame-timeline";
import { DEFAULT_ROBOT_ACTION, ROBOT_IDLE_ACTIONS } from "@/features/floating/model/robot-actions";
import type { RobotActionConfig, RobotIdleAction } from "@/features/floating/model/robot-actions";

export {
  ANIMATION_SLOTS,
  ANIMATION_TRIGGERS,
  DEFAULT_ROBOT_ACTION,
  ROBOT_IDLE_ACTIONS,
  TRACK_PLAYBACKS,
};
export type { AnimationSlot, AnimationTrigger, RobotActionConfig, RobotIdleAction, TrackPlayback };

/** 单个轨道最多可含的帧数（本地文件存储架构）。 */
export const MAX_FRAMES = 60;
/** 全部状态轨道合计最多可含的帧数。 */
export const MAX_TOTAL_FRAMES = 180;
/** 帧图缩放后的最长边（像素）；支持高分屏与 150% 缩放。 */
export const FRAME_SIZE = 256;
/** 播放速度范围（帧/秒）。 */
export const MIN_FPS = 1;
export const MAX_FPS = 30;

/** 播放方式：循环、往返、仅悬停时播放、静止（只显示第一帧）。 */
export const PLAYBACKS = ["loop", "pingpong", "hover", "still"] as const;
/** 播放方式名称。 */
export type Playback = (typeof PLAYBACKS)[number];

/** 附加动效：无、轻轻漂浮、呼吸缩放、弹跳。 */
export const MOTIONS = ["none", "float", "breathe", "bounce"] as const;
/** 附加动效名称。 */
export type Motion = (typeof MOTIONS)[number];

export const AVATAR_MODES = ["robot", "image", "badge"] as const;
export const ROBOTS = ["scout", "relay", "memo"] as const;
export const ROBOT_COLORS = ["original", "steel", "mint", "amber", "lilac", "pearl"] as const;
export const ROBOT_FACES = ["friendly", "focused", "playful"] as const;

/** 本地落盘帧图的元数据（清单中不含二进制内容）。 */
export type SkinAssetMeta = {
  id: string;
  ext: "webp" | "png";
  width: number;
  height: number;
  sizeBytes: number;
};

/** 轨道中的单帧引用。 */
export type FrameRef = {
  assetId: string;
  /** 可选单帧停留时长（ms）；缺省时按轨道 fps 计算。 */
  durationMs?: number;
};

/** 单个状态槽位的动画轨道。 */
export type AnimationTrack = {
  frames: FrameRef[];
  fps: number;
  playback: TrackPlayback;
};

/** 悬浮窗皮肤与动画配置（Schema v2）。 */
export type Skin = {
  version: 2;
  mode: (typeof AVATAR_MODES)[number];
  robot: (typeof ROBOTS)[number];
  color: (typeof ROBOT_COLORS)[number];
  face: (typeof ROBOT_FACES)[number];
  /** 旧版内联帧图（仅用于平滑迁移或测试兜底；迁移完成后置空）。 */
  frames: string[];
  fps: number;
  playback: Playback;
  motion: Motion;
  /** 像素风：最近邻缩放，保持像素边缘锐利。 */
  pixel: boolean;
  /** 皮肤旁是否仍显示待办数。 */
  showCount: boolean;
  /** 悬浮窗动画总开关；关闭后所有悬浮窗动画停止。 */
  animationEnabled: boolean;
  /** 悬浮窗动画触发策略。 */
  animationTrigger: AnimationTrigger;
  /** 内置悬浮机器人动作配置。 */
  robotAction: RobotActionConfig;
  /** 已落盘的本地帧图资源索引（`assetId -> SkinAssetMeta`）。 */
  assets: Record<string, SkinAssetMeta>;
  /** 按状态槽位组织的动画轨道。 */
  tracks: Partial<Record<AnimationSlot, AnimationTrack>>;
};

export const DEFAULT_SKIN: Skin = {
  version: 2,
  mode: "robot",
  robot: "scout",
  color: "original",
  face: "friendly",
  frames: [],
  fps: 8,
  // D-13：默认仅悬停时播放，常驻不跑计时器；循环类需用户显式选择。
  playback: "hover",
  motion: "none",
  pixel: false,
  showCount: true,
  animationEnabled: true,
  animationTrigger: "interactive",
  robotAction: { ...DEFAULT_ROBOT_ACTION },
  assets: {},
  tracks: {},
};

/** 皮肤在 localStorage 中的 key；悬浮窗与主窗口共用，靠 `storage` 事件同步。 */
export const SKIN_STORAGE_KEY = "nivlo.skin";

/** 非 Tauri 预览/测试环境下的内存 URL 映射（`fileName -> dataUrl`）。 */
const previewUrlCache = new Map<string, string>();

/** 记录非 Tauri 环境下的本地资源预览 URL。 */
export function registerPreviewAssetUrl(fileName: string, dataUrl: string): void {
  previewUrlCache.set(fileName, dataUrl);
}

/**
 * 解析本地皮肤帧图在 WebView 中可加载的 URL。
 *
 * Windows WebView2 下 Tauri 自定义协议映射到 `http://nivlo-skin.localhost/<file>`，
 * macOS / Linux 下为 `nivlo-skin://localhost/<file>`；非 Tauri 开发预览优先返回内存缓存。
 */
export function skinAssetUrl(asset: Pick<SkinAssetMeta, "id" | "ext">): string {
  const fileName = `${asset.id}.${asset.ext}`;
  if (!isRunningInTauri()) {
    const cached = previewUrlCache.get(fileName);
    if (cached !== undefined) return cached;
  }
  const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
  return isWindows
    ? `http://nivlo-skin.localhost/${fileName}`
    : `nivlo-skin://localhost/${fileName}`;
}

/** 收集清单中所有轨道正在引用的本地资源文件名（用于孤儿文件 GC）。 */
export function collectReferencedAssetFiles(skin: Skin): string[] {
  const files = new Set<string>();
  for (const track of Object.values(skin.tracks)) {
    if (!track) continue;
    for (const frame of track.frames) {
      const meta = skin.assets[frame.assetId];
      if (meta) files.add(`${meta.id}.${meta.ext}`);
    }
  }
  return [...files];
}

/** 有可用的自定义图片帧时才使用图片徽标尺寸。 */
export function hasImageSkin(skin: Skin): boolean {
  if (skin.mode !== "image") return false;
  if (skin.frames.length > 0) return true;
  return Object.values(skin.tracks).some((track) => (track?.frames.length ?? 0) > 0);
}

/** 统计全部轨道的帧总数。 */
export function countTotalTrackFrames(skin: Skin): number {
  let total = 0;
  for (const track of Object.values(skin.tracks)) {
    if (track) total += track.frames.length;
  }
  return total;
}

/** 解析后的可播放帧列表。 */
export type ResolvedTrack = {
  frames: { src: string; durationMs: number; assetId?: string }[];
  playback: TrackPlayback;
  hoverOnly: boolean;
};

/**
 * 解析指定状态槽位的帧序列；未配置该槽位时自动回退到 `idle`，再回退到旧版 `frames[]`。
 */
export function resolveSkinTrack(skin: Skin, slot: AnimationSlot): ResolvedTrack {
  const track =
    (skin.tracks[slot]?.frames.length ? skin.tracks[slot] : undefined) ??
    (skin.tracks.idle?.frames.length ? skin.tracks.idle : undefined);

  if (track) {
    const defaultMs = Math.round(1000 / Math.max(MIN_FPS, track.fps));
    const resolved = track.frames
      .map((ref) => {
        const meta = skin.assets[ref.assetId];
        if (!meta) return null;
        return {
          src: skinAssetUrl(meta),
          durationMs: ref.durationMs ?? defaultMs,
          assetId: ref.assetId,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return {
      frames: resolved,
      playback: track.playback,
      hoverOnly: skin.animationTrigger === "hoverOnly" || skin.playback === "hover",
    };
  }

  // 向后兼容旧版内联 `frames[]`。
  const defaultMs = Math.round(1000 / Math.max(MIN_FPS, skin.fps));
  const playback: TrackPlayback =
    skin.playback === "hover" ? "loop" : skin.playback === "pingpong" ? "pingpong" : skin.playback;
  return {
    frames: skin.frames.map((src) => ({ src, durationMs: defaultMs })),
    playback,
    hoverOnly: skin.playback === "hover" || skin.animationTrigger === "hoverOnly",
  };
}

/** 按白名单取值，非法时回退。 */
function pick<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** 校验并清洗 `robotAction` 字段。 */
function sanitizeRobotAction(raw: unknown): RobotActionConfig {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    idle: pick(ROBOT_IDLE_ACTIONS, o["idle"], DEFAULT_ROBOT_ACTION.idle),
    hover: typeof o["hover"] === "boolean" ? o["hover"] : DEFAULT_ROBOT_ACTION.hover,
    grabbed: typeof o["grabbed"] === "boolean" ? o["grabbed"] : DEFAULT_ROBOT_ACTION.grabbed,
    ready: typeof o["ready"] === "boolean" ? o["ready"] : DEFAULT_ROBOT_ACTION.ready,
    done: typeof o["done"] === "boolean" ? o["done"] : DEFAULT_ROBOT_ACTION.done,
    reminder: typeof o["reminder"] === "boolean" ? o["reminder"] : DEFAULT_ROBOT_ACTION.reminder,
  };
}

/** 校验并清洗 `assets` 索引。 */
function sanitizeAssets(raw: unknown): Record<string, SkinAssetMeta> {
  if (typeof raw !== "object" || raw === null) return {};
  const result: Record<string, SkinAssetMeta> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEX_64.test(key) || typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const ext = v["ext"] === "webp" || v["ext"] === "png" ? v["ext"] : null;
    if (ext === null) continue;
    const width =
      typeof v["width"] === "number" && Number.isFinite(v["width"]) && v["width"] > 0
        ? Math.min(FRAME_SIZE, Math.round(v["width"]))
        : FRAME_SIZE;
    const height =
      typeof v["height"] === "number" && Number.isFinite(v["height"]) && v["height"] > 0
        ? Math.min(FRAME_SIZE, Math.round(v["height"]))
        : FRAME_SIZE;
    const sizeBytes =
      typeof v["sizeBytes"] === "number" && Number.isFinite(v["sizeBytes"]) && v["sizeBytes"] > 0
        ? Math.round(v["sizeBytes"])
        : 0;
    result[key] = { id: key, ext, width, height, sizeBytes };
  }
  return result;
}

/** 校验并清洗 `tracks` 轨道表。 */
function sanitizeTracks(
  raw: unknown,
  assets: Record<string, SkinAssetMeta>,
  fallbackFps: number,
): Partial<Record<AnimationSlot, AnimationTrack>> {
  if (typeof raw !== "object" || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const tracks: Partial<Record<AnimationSlot, AnimationTrack>> = {};
  let totalFrames = 0;

  for (const slot of ANIMATION_SLOTS) {
    const entry = source[slot];
    if (typeof entry !== "object" || entry === null) continue;
    const t = entry as Record<string, unknown>;
    if (!Array.isArray(t["frames"])) continue;
    const remainingBudget = MAX_TOTAL_FRAMES - totalFrames;
    if (remainingBudget <= 0) break;

    const frames: FrameRef[] = [];
    for (const item of t["frames"]) {
      if (frames.length >= Math.min(MAX_FRAMES, remainingBudget)) break;
      if (typeof item !== "object" || item === null) continue;
      const f = item as Record<string, unknown>;
      const assetId = f["assetId"];
      if (typeof assetId !== "string" || assets[assetId] === undefined) continue;
      const rawDuration = f["durationMs"];
      const durationMs =
        typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration >= 16
          ? Math.min(10_000, Math.round(rawDuration))
          : undefined;
      frames.push(durationMs === undefined ? { assetId } : { assetId, durationMs });
    }
    if (frames.length === 0) continue;
    totalFrames += frames.length;
    const fps =
      typeof t["fps"] === "number" && Number.isFinite(t["fps"])
        ? Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(t["fps"])))
        : fallbackFps;
    tracks[slot] = {
      frames,
      fps,
      playback: pick(TRACK_PLAYBACKS, t["playback"], slot === "done" ? "once" : "loop"),
    };
  }
  return tracks;
}

/**
 * 校验并补全任意来源的皮肤，非法字段回退到默认值；兼容旧版内联 PNG data URL 与新版磁盘资源清单。
 *
 * @param raw 解析后的 JSON。
 * @returns 合法的皮肤。
 */
export function sanitizeSkin(raw: unknown): Skin {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const frames = Array.isArray(o["frames"])
    ? o["frames"]
        .filter((f): f is string => typeof f === "string" && f.startsWith("data:image/png;base64,"))
        .slice(0, MAX_FRAMES)
    : [];
  const fps =
    typeof o["fps"] === "number" && Number.isFinite(o["fps"])
      ? Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(o["fps"])))
      : DEFAULT_SKIN.fps;
  const assets = sanitizeAssets(o["assets"]);
  const tracks = sanitizeTracks(o["tracks"], assets, fps);
  const hasAnyImage = frames.length > 0 || Object.keys(tracks).length > 0;

  return {
    version: 2,
    mode: pick(AVATAR_MODES, o["mode"], hasAnyImage ? "image" : DEFAULT_SKIN.mode),
    robot: pick(ROBOTS, o["robot"], DEFAULT_SKIN.robot),
    color: pick(ROBOT_COLORS, o["color"], DEFAULT_SKIN.color),
    face: pick(ROBOT_FACES, o["face"], DEFAULT_SKIN.face),
    frames,
    fps,
    playback: pick(PLAYBACKS, o["playback"], DEFAULT_SKIN.playback),
    motion: pick(MOTIONS, o["motion"], DEFAULT_SKIN.motion),
    pixel: typeof o["pixel"] === "boolean" ? o["pixel"] : DEFAULT_SKIN.pixel,
    showCount: typeof o["showCount"] === "boolean" ? o["showCount"] : DEFAULT_SKIN.showCount,
    animationEnabled:
      typeof o["animationEnabled"] === "boolean"
        ? o["animationEnabled"]
        : DEFAULT_SKIN.animationEnabled,
    animationTrigger: pick(
      ANIMATION_TRIGGERS,
      o["animationTrigger"],
      DEFAULT_SKIN.animationTrigger,
    ),
    robotAction: sanitizeRobotAction(o["robotAction"]),
    assets,
    tracks,
  };
}

/**
 * 计算下一帧下标与方向（保留供外部调用与单元测试兼容）。
 */
export function nextFrame(
  index: number,
  length: number,
  playback: Playback,
  direction: 1 | -1,
): { index: number; direction: 1 | -1 } {
  if (length <= 1 || playback === "still") return { index: 0, direction: 1 };
  if (playback === "pingpong") {
    let dir = direction;
    if (index + dir >= length || index + dir < 0) dir = dir === 1 ? -1 : 1;
    return { index: index + dir, direction: dir };
  }
  return { index: (index + 1) % length, direction: 1 };
}

/** 把 Canvas 编码为最合适的本地皮肤格式（像素风用无损 PNG，普通图优先 WebP）。 */
export function encodeCanvasFrame(
  canvas: HTMLCanvasElement,
  pixel: boolean,
): { bytesBase64: string; format: "webp" | "png"; dataUrl: string } {
  if (!pixel) {
    const webp = canvas.toDataURL("image/webp", 0.9);
    if (webp.startsWith("data:image/webp;base64,")) {
      return {
        bytesBase64: webp.slice("data:image/webp;base64,".length),
        format: "webp",
        dataUrl: webp,
      };
    }
  }
  const png = canvas.toDataURL("image/png");
  return {
    bytesBase64: png.slice("data:image/png;base64,".length),
    format: "png",
    dataUrl: png,
  };
}

/**
 * 把一张图片缩放至 [`FRAME_SIZE`]（256px）以内并落盘到 `skins/assets/`。
 */
export async function saveImageSourceToAsset(
  source: CanvasImageSource & { width: number; height: number },
  pixel: boolean,
): Promise<SkinAssetMeta> {
  const scale = Math.min(1, FRAME_SIZE / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("canvas unavailable");
  ctx.imageSmoothingEnabled = !pixel;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  const encoded = encodeCanvasFrame(canvas, pixel);
  const stored = await ipc.saveSkinAsset(encoded.bytesBase64, encoded.format);
  const ext = stored.ext === "webp" ? "webp" : "png";
  if (!isRunningInTauri()) {
    registerPreviewAssetUrl(`${stored.id}.${ext}`, encoded.dataUrl);
  }
  return {
    id: stored.id,
    ext,
    width: canvas.width,
    height: canvas.height,
    sizeBytes: stored.sizeBytes,
  };
}

/**
 * 把单个图片文件缩放并保存到本地 `skins/assets/`。
 */
export async function fileToSkinAsset(file: File, pixel: boolean): Promise<SkinAssetMeta> {
  const bitmap = await createImageBitmap(file);
  try {
    return await saveImageSourceToAsset(bitmap, pixel);
  } finally {
    bitmap.close();
  }
}

/**
 * 把图片文件缩放成不超过 [`FRAME_SIZE`] 的 PNG data URL（保留兼容）。
 */
export async function fileToFrame(file: File, pixel: boolean): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, FRAME_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("canvas unavailable");
    ctx.imageSmoothingEnabled = !pixel;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

/** 将全局动画开关同步到根元素，供 CSS 统一关闭悬浮窗动效。 */
export function applySkinAnimationFlag(skin: Skin): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset["floatingAnimation"] = skin.animationEnabled ? "on" : "off";
}

/** 读取已保存的皮肤。 */
function load(): Skin {
  try {
    const saved = window.localStorage.getItem(SKIN_STORAGE_KEY);
    if (saved !== null) return sanitizeSkin(JSON.parse(saved));
  } catch {
    // localStorage 不可用或内容损坏：不使用皮肤。
  }
  return DEFAULT_SKIN;
}

/** 皮肤预览及保存状态。 */
type SkinState = {
  skin: Skin;
  saveStatus: "idle" | "saving" | "failed";
  update: (patch: Partial<Skin>) => void;
  retry: () => void;
  adopt: (skin: Skin) => void;
  hydrate: (json: string | null) => void;
  /** 将旧版内联 Base64 帧图一次性迁移到本地 `skins/assets/`（仅主窗口调用）。 */
  migrateLegacyFrames: () => Promise<void>;
  /** 清理 `skins/assets/` 中未被清单引用的孤儿文件。 */
  pruneUnusedAssets: () => Promise<number>;
};

/** 悬浮窗皮肤状态。 */
export const useSkinStore = create<SkinState>((set, get) => {
  /** 依次保存，写入期间只保留最新待写快照。 */
  async function save(): Promise<void> {
    if (get().saveStatus === "saving") return;
    set({ saveStatus: "saving" });
    for (;;) {
      const snapshot = get().skin;
      const json = JSON.stringify(snapshot);
      try {
        await ipc.setUiPref("skin", json);
        window.localStorage.setItem(SKIN_STORAGE_KEY, json);
      } catch {
        if (snapshot !== get().skin) continue;
        set({ saveStatus: "failed" });
        return;
      }
      if (snapshot === get().skin) {
        set({ saveStatus: "idle" });
        return;
      }
    }
  }

  return {
    skin: load(),
    saveStatus: "idle",
    update: (patch) => {
      const next = sanitizeSkin({ ...get().skin, ...patch });
      applySkinAnimationFlag(next);
      set({ skin: next });
      void save();
    },
    retry: () => {
      if (get().saveStatus === "failed") void save();
    },
    adopt: (skin) => {
      if (get().saveStatus === "idle") {
        applySkinAnimationFlag(skin);
        set({ skin });
      }
    },
    hydrate: (json) => {
      if (get().saveStatus !== "idle") return;
      try {
        const next = json === null ? DEFAULT_SKIN : sanitizeSkin(JSON.parse(json));
        if (json === null) window.localStorage.removeItem(SKIN_STORAGE_KEY);
        else window.localStorage.setItem(SKIN_STORAGE_KEY, JSON.stringify(next));
        applySkinAnimationFlag(next);
        set({ skin: next });
      } catch {
        // 内容损坏时保留本地缓存。
      }
    },
    migrateLegacyFrames: async () => {
      const current = get().skin;
      if (current.frames.length === 0 || (current.tracks.idle?.frames.length ?? 0) > 0) return;
      const nextAssets: Record<string, SkinAssetMeta> = { ...current.assets };
      const refs: FrameRef[] = [];
      for (const dataUrl of current.frames) {
        if (!dataUrl.startsWith("data:image/png;base64,")) continue;
        const base64 = dataUrl.slice("data:image/png;base64,".length);
        try {
          const stored = await ipc.saveSkinAsset(base64, "png");
          const ext = stored.ext === "webp" ? "webp" : "png";
          if (!isRunningInTauri()) registerPreviewAssetUrl(`${stored.id}.${ext}`, dataUrl);
          nextAssets[stored.id] = {
            id: stored.id,
            ext,
            width: 96,
            height: 96,
            sizeBytes: stored.sizeBytes,
          };
          refs.push({ assetId: stored.id });
        } catch {
          // 单帧迁移失败：放弃本次迁移，保留旧版 Base64 数据不丢失。
          return;
        }
      }
      if (refs.length === 0) return;
      const playback: TrackPlayback =
        current.playback === "pingpong"
          ? "pingpong"
          : current.playback === "still"
            ? "still"
            : "loop";
      get().update({
        frames: [],
        assets: nextAssets,
        tracks: {
          ...current.tracks,
          idle: { frames: refs, fps: current.fps, playback },
        },
      });
    },
    pruneUnusedAssets: async () => {
      const keepFiles = collectReferencedAssetFiles(get().skin);
      return ipc.pruneSkinAssets(keepFiles);
    },
  };
});

/** 启动时应用动画开关，并监听其他窗口对皮肤的修改。 */
export function initSkin(): void {
  applySkinAnimationFlag(useSkinStore.getState().skin);
  window.addEventListener("storage", (event) => {
    if (event.key !== SKIN_STORAGE_KEY) return;
    try {
      const next =
        event.newValue === null ? DEFAULT_SKIN : sanitizeSkin(JSON.parse(event.newValue));
      useSkinStore.getState().adopt(next);
    } catch {
      // 内容损坏时忽略。
    }
  });
}
