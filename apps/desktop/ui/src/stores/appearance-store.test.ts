import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, sanitizeAppearance } from "./appearance-store";

describe("sanitizeAppearance", () => {
  it("returns defaults for garbage input", () => {
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance("x")).toEqual(DEFAULT_APPEARANCE);
  });

  it("falls back per field and clamps opacity", () => {
    const result = sanitizeAppearance({ accent: "rose", surface: "bogus", opacity: 5 });
    expect(result.accent).toBe("rose");
    expect(result.surface).toBe(DEFAULT_APPEARANCE.surface);
    expect(result.opacity).toBe(40);
    expect(sanitizeAppearance({ opacity: 500 }).opacity).toBe(100);
  });
});

describe("backend persistence (D-14)", () => {
  it("writes updates to the backend and hydrates from it", { timeout: 30000 }, async () => {
    const { createMemoryIpc } = await import("@/test/ipc-mock");
    const { setIpcClient } = await import("@/lib/ipc");
    const { useAppearanceStore } = await import("./appearance-store");
    const memory = createMemoryIpc();
    setIpcClient(memory);

    useAppearanceStore.getState().update({ accent: "rose" });
    await Promise.resolve();
    const saved = await memory.getUiPref("appearance");
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved ?? "{}").accent).toBe("rose");

    useAppearanceStore.getState().hydrate(JSON.stringify({ accent: "teal" }));
    expect(useAppearanceStore.getState().appearance.accent).toBe("teal");
    useAppearanceStore.getState().hydrate("not json");
    expect(useAppearanceStore.getState().appearance.accent).toBe("teal");
  });
});
