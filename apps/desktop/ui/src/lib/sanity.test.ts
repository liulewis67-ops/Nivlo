import { describe, expect, it } from "vitest";
import { isBlank } from "./sanity";

describe("isBlank", () => {
  it("treats whitespace-only strings as blank", () => {
    expect(isBlank("  \t")).toBe(true);
  });

  it("treats text as non-blank", () => {
    expect(isBlank(" a ")).toBe(false);
  });
});
