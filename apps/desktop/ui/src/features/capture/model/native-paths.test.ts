import { describe, expect, it, vi } from "vitest";
import { requestFilePaths } from "./native-paths";

describe("requestFilePaths", () => {
  it("不在 WebView2 里（没有消息桥）时返回 null", async () => {
    expect(await requestFilePaths([new File(["x"], "a.txt")], null)).toBeNull();
    expect(await requestFilePaths([new File(["x"], "a.txt")], {})).toBeNull();
  });

  it("没有文件时不发消息", async () => {
    const post = vi.fn();
    expect(await requestFilePaths([], { postMessageWithAdditionalObjects: post })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});
