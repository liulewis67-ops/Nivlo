import { describe, expect, it } from "vitest";
import { useDisplayStore } from "./display-store";

describe("display store", () => {
  it("hydrates only valid values", () => {
    useDisplayStore.getState().hydrate("true");
    expect(useDisplayStore.getState().hideCompleted).toBe(true);
    useDisplayStore.getState().hydrate("bogus");
    expect(useDisplayStore.getState().hideCompleted).toBe(true);
    useDisplayStore.getState().hydrate("false");
    expect(useDisplayStore.getState().hideCompleted).toBe(false);
  });
});
