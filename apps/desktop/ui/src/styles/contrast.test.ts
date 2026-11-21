import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** 设计 Token 的原文。 */
const CSS = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

/**
 * 取出一个选择器块里的颜色 Token（`--nv-name: #rrggbb`）。
 *
 * @param selector 选择器文本（如 `[data-theme="dark"]`）。
 * @returns Token 名 → 颜色。
 */
function colorsOf(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`没有找到 ${selector}`);
  const block = CSS.slice(start, CSS.indexOf("}", start));
  const colors: Record<string, string> = {};
  for (const match of block.matchAll(/--nv-([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)) {
    colors[match[1] ?? ""] = match[2] ?? "";
  }
  return colors;
}

/**
 * 相对亮度（WCAG 2.1）。
 *
 * @param hex `#rrggbb`。
 * @returns 0..1。
 */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 两个颜色的对比度（WCAG 2.1）。
 *
 * @param a 颜色 A。
 * @param b 颜色 B。
 * @returns 1..21。
 */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** 两套主题（深色在浅色之上覆盖）。 */
const LIGHT = colorsOf(":root");
const THEMES: Array<[string, Record<string, string>]> = [
  ["浅色", LIGHT],
  ["深色", { ...LIGHT, ...colorsOf('[data-theme="dark"]') }],
];

/** 文字 + 背景的组合：正文要求至少 4.5:1（WCAG AA）。 */
const TEXT_PAIRS: Array<[string, string]> = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "surface-hover"],
  ["text-muted", "bg"],
  ["text-muted", "surface"],
  ["text-muted", "surface-hover"],
  ["primary-contrast", "primary"],
  ["primary-contrast", "primary-hover"],
  ["danger-contrast", "danger"],
  ["primary", "bg"],
  ["primary", "surface"],
  ["danger", "bg"],
  ["danger", "surface"],
  ["success", "surface"],
];

describe.each(THEMES)("对比度（%s主题）", (_name, colors) => {
  it.each(TEXT_PAIRS)("%s 在 %s 上至少 4.5:1", (foreground, background) => {
    const fg = colors[foreground];
    const bg = colors[background];
    expect(fg, foreground).toBeDefined();
    expect(bg, background).toBeDefined();
    expect(contrast(fg ?? "", bg ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it("焦点环与背景至少 3:1（WCAG 2.1 非文本对比度）", () => {
    for (const background of ["bg", "surface"]) {
      expect(contrast(colors["focus-ring"] ?? "", colors[background] ?? "")).toBeGreaterThanOrEqual(
        3,
      );
    }
  });
});
