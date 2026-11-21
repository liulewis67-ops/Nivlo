import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coalesce } from "./coalesce";

describe("coalesce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a single signal immediately and nothing afterwards", () => {
    const run = vi.fn();
    const { signal } = coalesce(run, 50);
    signal();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst into one leading and one trailing run", () => {
    const run = vi.fn();
    const { signal } = coalesce(run, 50);
    for (let i = 0; i < 40; i += 1) signal();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs at most once per window under a steady stream", () => {
    const run = vi.fn();
    const { signal } = coalesce(run, 50);
    for (let t = 0; t < 500; t += 10) {
      signal();
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(100);
    // 500 ms 的事件流：领先 1 次 + 每 50 ms 最多 1 次。
    expect(run.mock.calls.length).toBeLessThanOrEqual(12);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it("a signal after a quiet window runs immediately again", () => {
    const run = vi.fn();
    const { signal } = coalesce(run, 50);
    signal();
    vi.advanceTimersByTime(60);
    signal();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancel drops the pending trailing run", () => {
    const run = vi.fn();
    const { signal, cancel } = coalesce(run, 50);
    signal();
    signal();
    cancel();
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
