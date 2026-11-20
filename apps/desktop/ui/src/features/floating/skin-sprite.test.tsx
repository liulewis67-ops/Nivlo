import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SKIN } from "@/stores/skin-store";
import type { Skin } from "@/stores/skin-store";
import { SkinSprite } from "./SkinSprite";

const A = "data:image/png;base64,AAAA";
const B = "data:image/png;base64,BBBB";
const LOOPING: Skin = {
  ...DEFAULT_SKIN,
  animationEnabled: true,
  frames: [A, B],
  fps: 10,
  playback: "loop",
};

/** 让 matchMedia 对「减少动态效果」返回指定值。 */
function mockReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: reduce && query.includes("reduce"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SkinSprite", () => {
  it("advances frames while a loop skin is visible", () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const { container } = render(<SkinSprite skin={LOOPING} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(A);
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(B);
  });

  it("shows only the first frame under reduced motion", () => {
    vi.useFakeTimers();
    mockReducedMotion(true);
    const { container } = render(<SkinSprite skin={LOOPING} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(A);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs no timer for the default hover-only skin when not hovered", () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    render(<SkinSprite skin={{ ...LOOPING, playback: "hover" }} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the timer and the extra motion while the page is hidden", () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const { container } = render(<SkinSprite skin={{ ...LOOPING, motion: "bounce" }} />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(container.querySelector("img")?.className).toContain("nv-skin-bounce");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector("img")?.className).not.toContain("nv-skin-bounce");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("stops the timer and motion when animationEnabled is false", () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const { container } = render(
      <SkinSprite skin={{ ...LOOPING, animationEnabled: false, motion: "float" }} />,
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(A);
    expect(container.querySelector("img")?.className).not.toContain("nv-skin-float");
  });
});
