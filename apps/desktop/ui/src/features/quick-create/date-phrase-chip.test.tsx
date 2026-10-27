import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DatePhraseChip } from "./DatePhraseChip";
import { parseDatePhrase } from "./model/date-phrase";

describe("DatePhraseChip", () => {
  const parsed = parseDatePhrase("交房租 明天", "2026-10-10");

  it("鼠标按下 ✕ 取消识别（不等 click，避免输入框先失焦）", () => {
    const onDismiss = vi.fn();
    if (parsed === null) throw new Error("应当识别出日期");
    render(<DatePhraseChip parsed={parsed} onDismiss={onDismiss} />);
    const cancel = screen.getByRole("button", { name: "取消日期识别" });
    fireEvent.mouseDown(cancel);
    // 鼠标点击随后的 click（detail 为 1）不会再取消一次。
    fireEvent.click(cancel, { detail: 1 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("键盘（Enter / Space 触发的 click）也能取消", () => {
    const onDismiss = vi.fn();
    if (parsed === null) throw new Error("应当识别出日期");
    render(<DatePhraseChip parsed={parsed} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "取消日期识别" }), { detail: 0 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
