import { describe, expect, it } from "vitest";
import { blockBrowserReflexKeys, isBrowserReflexKey } from "./browser-keys";

/** 构造按键。 */
function key(name: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
  return {
    key: name,
    ctrlKey: modifiers.ctrl ?? false,
    metaKey: false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
  };
}

describe("isBrowserReflexKey", () => {
  it("刷新、打印、另存、查看源代码", () => {
    expect(isBrowserReflexKey(key("F5"))).toBe(true);
    expect(isBrowserReflexKey(key("F5", { ctrl: true }))).toBe(true);
    expect(isBrowserReflexKey(key("r", { ctrl: true }))).toBe(true);
    expect(isBrowserReflexKey(key("R", { ctrl: true, shift: true }))).toBe(true);
    expect(isBrowserReflexKey(key("p", { ctrl: true }))).toBe(true);
    expect(isBrowserReflexKey(key("s", { ctrl: true }))).toBe(true);
    expect(isBrowserReflexKey(key("u", { ctrl: true }))).toBe(true);
  });

  it("普通输入、编辑键、缩放与查找不拦", () => {
    expect(isBrowserReflexKey(key("r"))).toBe(false);
    expect(isBrowserReflexKey(key("c", { ctrl: true }))).toBe(false);
    expect(isBrowserReflexKey(key("v", { ctrl: true }))).toBe(false);
    expect(isBrowserReflexKey(key("f", { ctrl: true }))).toBe(false);
    expect(isBrowserReflexKey(key("=", { ctrl: true }))).toBe(false);
    expect(isBrowserReflexKey(key("k", { ctrl: true }))).toBe(false);
    expect(isBrowserReflexKey(key("r", { ctrl: true, alt: true }))).toBe(false);
  });
});

describe("blockBrowserReflexKeys", () => {
  it("拦下浏览器功能键但不挡住页面里的其他监听者；卸载后不再拦", () => {
    const seen: string[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listener);
    const uninstall = blockBrowserReflexKeys(window);

    const reload = new KeyboardEvent("keydown", { key: "F5", cancelable: true });
    window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(true);
    const typing = new KeyboardEvent("keydown", { key: "a", cancelable: true });
    window.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
    expect(seen).toEqual(["F5", "a"]);

    uninstall();
    const later = new KeyboardEvent("keydown", { key: "F5", cancelable: true });
    window.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    window.removeEventListener("keydown", listener);
  });
});
