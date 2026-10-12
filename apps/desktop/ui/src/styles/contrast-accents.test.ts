import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const GLOBAL = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

/** 取出一个选择器块里的颜色 Token。 */
function colorsIn(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return {};
  const block = css.slice(start, css.indexOf("}", start));
  const colors: Record<string, string> = {};
  for (const m of block.matchAll(/--nv-([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)) {
    colors[m[1] ?? ""] = m[2] ?? "";
  }
  return colors;
}

/** WCAG 相对亮度。 */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度。 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const ACCENTS = ["violet", "teal", "rose", "amber"] as const;
const BASE_LIGHT = colorsIn(TOKENS, ":root");
const BASE_DARK = { ...BASE_LIGHT, ...colorsIn(TOKENS, '[data-theme="dark"]') };

/** 某个主题下某个强调色的完整 Token（强调色块覆盖基础值）。 */
function accentTokens(theme: "light" | "dark", accent: string): Record<string, string> {
  const base = theme === "light" ? BASE_LIGHT : BASE_DARK;
  const selector =
    theme === "light"
      ? `html[data-accent="${accent}"]`
      : `html[data-theme="dark"][data-accent="${accent}"]`;
  return { ...base, ...colorsIn(GLOBAL, selector) };
}

describe.each(["light", "dark"] as const)("强调色预设的对比度（%s）", (theme) => {
  it.each(ACCENTS)("%s：按钮文字在主色及悬停色上至少 4.5:1", (accent) => {
    const t = accentTokens(theme, accent);
    expect(contrast(t["primary-contrast"] ?? "", t["primary"] ?? "")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["primary-contrast"] ?? "", t["primary-hover"] ?? "")).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it.each(ACCENTS)("%s：焦点环相对页面与卡片背景至少 3:1（WCAG 非文字对比度）", (accent) => {
    const t = accentTokens(theme, accent);
    expect(contrast(t["focus-ring"] ?? "", t["bg"] ?? "")).toBeGreaterThanOrEqual(3);
    expect(contrast(t["focus-ring"] ?? "", t["surface"] ?? "")).toBeGreaterThanOrEqual(3);
  });

  it.each(ACCENTS)("%s：主色文字（链接 / 选中项）在背景上至少 4.5:1", (accent) => {
    const t = accentTokens(theme, accent);
    expect(contrast(t["primary"] ?? "", t["bg"] ?? "")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["primary"] ?? "", t["surface"] ?? "")).toBeGreaterThanOrEqual(4.5);
  });
});
