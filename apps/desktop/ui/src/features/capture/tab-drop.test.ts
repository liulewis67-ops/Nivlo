import { describe, expect, it } from "vitest";
import { extractCapture } from "./model/extract-drop";
import { extractDraft } from "./model/drop-draft";
import { tabDropSnapshot } from "./tab-drop";

describe("tabDropSnapshot", () => {
  const payload = { url: "https://github.com/liulewis67-ops/rust_training", x: 10, y: 10 };

  it("becomes a web-link draft titled after the page", async () => {
    const outcome = await extractDraft(tabDropSnapshot({ ...payload, title: "rust_training" }));
    expect(outcome.kind).toBe("draft");
    if (outcome.kind !== "draft") return;
    expect(outcome.draft.links).toEqual([
      { kind: "web", url: payload.url, title: "rust_training" },
    ]);
  });

  it("still yields the link when the title is unknown", async () => {
    const outcome = await extractDraft(tabDropSnapshot({ ...payload, title: null }));
    expect(outcome.kind).toBe("draft");
    if (outcome.kind !== "draft") return;
    expect(outcome.draft.links.map((link) => link.kind === "web" && link.url)).toEqual([
      payload.url,
    ]);
  });

  it("captures the URL when dropped on the inbox zone", async () => {
    await expect(extractCapture(tabDropSnapshot({ ...payload, title: null }))).resolves.toEqual({
      kind: "input",
      input: { kind: "text", text: payload.url },
    });
  });
});
