import { describe, expect, it } from "vitest";
import {
  computeSpriteCells,
  duplicateFrame,
  reorderFrames,
  sampleFrameIndices,
  updateFrameDuration,
} from "./frame-import";

describe("sampleFrameIndices", () => {
  it("returns all indices when total <= max", () => {
    expect(sampleFrameIndices(4, 10)).toEqual([0, 1, 2, 3]);
  });

  it("evenly downsamples when total > max", () => {
    expect(sampleFrameIndices(10, 5)).toEqual([0, 2, 4, 6, 8]);
    expect(sampleFrameIndices(120, 60)).toHaveLength(60);
  });
});

describe("computeSpriteCells", () => {
  it("slices a 2x3 grid in row-major order and respects skipTrailing", () => {
    const cells = computeSpriteCells(300, 200, 2, 3, 1, 60);
    expect(cells).toHaveLength(5);
    expect(cells[0]).toEqual({ sx: 0, sy: 0, sw: 100, sh: 100 });
    expect(cells[3]).toEqual({ sx: 0, sy: 100, sw: 100, sh: 100 });
    expect(cells[4]).toEqual({ sx: 100, sy: 100, sw: 100, sh: 100 });
  });
});

describe("frame list editing helpers", () => {
  const sample = [{ assetId: "a" }, { assetId: "b" }, { assetId: "c" }];

  it("reorders frames cleanly", () => {
    expect(reorderFrames(sample, 0, 2).map((f) => f.assetId)).toEqual(["b", "c", "a"]);
    expect(reorderFrames(sample, 2, 0).map((f) => f.assetId)).toEqual(["c", "a", "b"]);
  });

  it("duplicates a frame up to maxFrames", () => {
    expect(duplicateFrame(sample, 1, 5).map((f) => f.assetId)).toEqual(["a", "b", "b", "c"]);
    expect(duplicateFrame(sample, 1, 3)).toHaveLength(3);
  });

  it("updates and clears per-frame duration with clamping", () => {
    const updated = updateFrameDuration(sample, 1, 250);
    expect(updated[1]).toEqual({ assetId: "b", durationMs: 250 });
    expect(updateFrameDuration(updated, 1, 5)[1]?.durationMs).toBe(16);
    expect(updateFrameDuration(updated, 1, undefined)[1]).toEqual({ assetId: "b" });
  });
});
