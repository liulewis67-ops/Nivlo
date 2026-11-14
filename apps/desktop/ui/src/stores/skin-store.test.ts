import { describe, expect, it } from "vitest";
import { DEFAULT_SKIN, MAX_FRAMES, nextFrame, sanitizeSkin } from "./skin-store";

const PNG = "data:image/png;base64,AAAA";

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
      ...Array(30).fill(PNG),
    ];
    const skin = sanitizeSkin({ frames, fps: 999, playback: "bogus", pixel: true });
    expect(skin.frames).toHaveLength(MAX_FRAMES);
    expect(skin.frames.every((f) => f === PNG)).toBe(true);
    expect(skin.fps).toBe(24);
    expect(skin.playback).toBe("hover");
    expect(skin.pixel).toBe(true);
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
