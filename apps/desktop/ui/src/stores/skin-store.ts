import { create } from "zustand";
import { ipc } from "@/lib/ipc";

/** 一套皮肤最多可含的帧数。 */
export const MAX_FRAMES = 16;
/** 帧图缩放后的最长边（像素）；悬浮徽标很小，不需要更大的图。 */
export const FRAME_SIZE = 96;
/** 播放速度范围（帧/秒）。 */
export const MIN_FPS = 1;
export const MAX_FPS = 24;

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

/** 用户自定义的徽标皮肤。 */
export type Skin = {
  mode: (typeof AVATAR_MODES)[number];
  robot: (typeof ROBOTS)[number];
  color: (typeof ROBOT_COLORS)[number];
  face: (typeof ROBOT_FACES)[number];
  /** 帧图（PNG data URL）。 */
  frames: string[];
  fps: number;
  playback: Playback;
  motion: Motion;
  /** 像素风：最近邻缩放，保持像素边缘锐利。 */
  pixel: boolean;
  /** 皮肤旁是否仍显示待办数。 */
  showCount: boolean;
};

export const DEFAULT_SKIN: Skin = {
  mode: "robot",
  robot: "scout",
  color: "original",
  face: "friendly",
  frames: [],
  fps: 6,
  // D-13：默认仅悬停时播放，常驻不跑计时器；循环类需用户显式选择。
  playback: "hover",
  motion: "none",
  pixel: false,
  showCount: true,
};

/** 皮肤在 localStorage 中的 key；悬浮窗与主窗口共用，靠 `storage` 事件同步。 */
export const SKIN_STORAGE_KEY = "nivlo.skin";

/** 有可用的自定义图片时才使用图片徽标尺寸。 */
export function hasImageSkin(skin: Skin): boolean {
  return skin.mode === "image" && skin.frames.length > 0;
}

/** 按白名单取值，非法时回退。 */
function pick<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * 校验并补全任意来源的皮肤，非法字段回退到默认值；只接受 PNG data URL。
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
  return {
    mode: pick(AVATAR_MODES, o["mode"], frames.length > 0 ? "image" : DEFAULT_SKIN.mode),
    robot: pick(ROBOTS, o["robot"], DEFAULT_SKIN.robot),
    color: pick(ROBOT_COLORS, o["color"], DEFAULT_SKIN.color),
    face: pick(ROBOT_FACES, o["face"], DEFAULT_SKIN.face),
    frames,
    fps,
    playback: pick(PLAYBACKS, o["playback"], DEFAULT_SKIN.playback),
    motion: pick(MOTIONS, o["motion"], DEFAULT_SKIN.motion),
    pixel: typeof o["pixel"] === "boolean" ? o["pixel"] : DEFAULT_SKIN.pixel,
    showCount: typeof o["showCount"] === "boolean" ? o["showCount"] : DEFAULT_SKIN.showCount,
  };
}

/**
 * 计算下一帧下标与方向。
 *
 * @param index 当前帧下标。
 * @param length 总帧数。
 * @param playback 播放方式。
 * @param direction 当前方向（1 正向，-1 反向，仅往返模式用）。
 * @returns 下一帧下标与方向。
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

/**
 * 把图片文件缩放成不超过 [`FRAME_SIZE`] 的 PNG data URL。
 *
 * @param file 用户选择的图片（GIF 取第一帧）。
 * @param pixel 为真时关闭平滑，保持像素边缘。
 * @returns PNG data URL。
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
      set({ skin: sanitizeSkin({ ...get().skin, ...patch }) });
      void save();
    },
    retry: () => {
      if (get().saveStatus === "failed") void save();
    },
    adopt: (skin) => {
      if (get().saveStatus === "idle") set({ skin });
    },
    hydrate: (json) => {
      if (get().saveStatus !== "idle") return;
      try {
        const next = json === null ? DEFAULT_SKIN : sanitizeSkin(JSON.parse(json));
        if (json === null) window.localStorage.removeItem(SKIN_STORAGE_KEY);
        else window.localStorage.setItem(SKIN_STORAGE_KEY, JSON.stringify(next));
        set({ skin: next });
      } catch {
        // 内容损坏时保留本地缓存。
      }
    },
  };
});

/** 监听其他窗口对皮肤的修改。 */
export function initSkin(): void {
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
