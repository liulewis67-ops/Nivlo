import { describe, expect, it, vi } from "vitest";
import { setIpcClient } from "@/lib/ipc";
import { createMemoryIpc } from "@/test/ipc-mock";
import {
  DEFAULT_SKIN,
  MAX_FRAMES,
  SKIN_STORAGE_KEY,
  nextFrame,
  sanitizeSkin,
  useSkinStore,
} from "./skin-store";

const PNG = "data:image/png;base64,AAAA";

describe("saving the desktop companion", () => {
  it("retains a failed preview and publishes the latest value only after a successful write", async () => {
    const memory = createMemoryIpc();
    const write = vi.spyOn(memory, "setUiPref");
    setIpcClient(memory);
    const store = useSkinStore.getState();
    store.hydrate(JSON.stringify({ frames: [PNG] }));
    expect(useSkinStore.getState().skin.mode).toBe("image");
    const original = localStorage.getItem(SKIN_STORAGE_KEY);
    write.mockRejectedValueOnce(new Error("database unavailable"));

    store.update({ mode: "robot", robot: "relay" });
    expect(useSkinStore.getState().skin.robot).toBe("relay");
    await vi.waitFor(() => expect(useSkinStore.getState().saveStatus).toBe("failed"));
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBe(original);

    let finishWrite!: () => void;
    write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    store.retry();
    store.update({ color: "mint" });
    store.update({ color: "steel" });
    expect(write).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBe(original);
    finishWrite();
    await vi.waitFor(() => expect(useSkinStore.getState().saveStatus).toBe("idle"));
    expect(write).toHaveBeenCalledTimes(3);

    const saved = await memory.getUiPref("skin");
    expect(saved).toBe(localStorage.getItem(SKIN_STORAGE_KEY));
    expect(JSON.parse(saved ?? "{}")).toMatchObject({
      mode: "robot",
      robot: "relay",
      color: "steel",
      frames: [PNG],
    });
    store.hydrate(null);
    expect(useSkinStore.getState().skin).toEqual(DEFAULT_SKIN);
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBeNull();
  });
});

describe("sanitizeSkin", () => {
  it("returns defaults for garbage", () => {
    expect(sanitizeSkin(null)).toEqual(DEFAULT_SKIN);
    expect(sanitizeSkin({ frames: "x", fps: "fast" })).toEqual(DEFAULT_SKIN);
  });

  it("keeps only png data urls, caps frames and clamps fps", () => {
    const frames = [
      PNG,
      "http://evil/x.png",
      "data:image/svg+xml;base64,AA",
      ...Array(70).fill(PNG),
    ];
    const skin = sanitizeSkin({ frames, fps: 999, playback: "bogus", pixel: true });
    expect(skin.frames).toHaveLength(MAX_FRAMES);
    expect(skin.frames.every((f) => f === PNG)).toBe(true);
    expect(skin.fps).toBe(30);
    expect(skin.playback).toBe("hover");
    expect(skin.pixel).toBe(true);
  });

  it("migrates legacy inline frames into local file assets and tracks", async () => {
    const memory = createMemoryIpc();
    setIpcClient(memory);
    const store = useSkinStore.getState();
    store.hydrate(JSON.stringify({ frames: [PNG], fps: 12, playback: "loop" }));
    await store.migrateLegacyFrames();

    const next = useSkinStore.getState().skin;
    expect(next.frames).toEqual([]);
    expect(next.tracks.idle?.frames).toHaveLength(1);
    expect(next.tracks.idle?.fps).toBe(12);
    expect(Object.keys(next.assets)).toHaveLength(1);
    expect(memory.calls).toContain("saveSkinAsset");
  });

  it("migrates an existing image skin while preserving an explicit companion choice", () => {
    expect(sanitizeSkin({ frames: [PNG] }).mode).toBe("image");
    expect(sanitizeSkin({ frames: [PNG], mode: "badge" })).toMatchObject({
      mode: "badge",
      frames: [PNG],
    });
    expect(
      sanitizeSkin({ frames: [PNG], mode: "robot", robot: "relay", face: "focused" }),
    ).toMatchObject({ mode: "robot", robot: "relay", face: "focused", frames: [PNG] });
  });
});

describe("nextFrame", () => {
  it("loops", () => {
    expect(nextFrame(2, 3, "loop", 1).index).toBe(0);
  });
  it("ping-pongs", () => {
    let s = { index: 0, direction: 1 as 1 | -1 };
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      s = nextFrame(s.index, 3, "pingpong", s.direction);
      seen.push(s.index);
    }
    expect(seen).toEqual([1, 2, 1, 0, 1, 2]);
  });
  it("stays on a single or still frame", () => {
    expect(nextFrame(0, 1, "loop", 1).index).toBe(0);
    expect(nextFrame(1, 3, "still", 1).index).toBe(0);
  });
});
