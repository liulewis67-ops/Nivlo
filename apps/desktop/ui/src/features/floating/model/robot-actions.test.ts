import { describe, expect, it } from "vitest";
import { DEFAULT_ROBOT_ACTION, resolveRobotSequence } from "./robot-actions";

describe("resolveRobotSequence", () => {
  it("disables all sequences when animationEnabled is false", () => {
    const seq = resolveRobotSequence({
      slot: "hover",
      action: DEFAULT_ROBOT_ACTION,
      animationEnabled: false,
      trigger: "always",
      hovered: true,
    });
    expect(seq.active).toBe(false);
    expect(seq.playback).toBe("still");
  });

  it("plays blink idle in interactive mode, and off disables idle", () => {
    const blink = resolveRobotSequence({
      slot: "idle",
      action: { ...DEFAULT_ROBOT_ACTION, idle: "blink" },
      animationEnabled: true,
      trigger: "interactive",
      hovered: false,
    });
    expect(blink.active).toBe(true);
    expect(blink.frames.length).toBeGreaterThan(1);

    const off = resolveRobotSequence({
      slot: "idle",
      action: { ...DEFAULT_ROBOT_ACTION, idle: "off" },
      animationEnabled: true,
      trigger: "always",
      hovered: false,
    });
    expect(off.active).toBe(false);
  });

  it("gates continuous float idle to always trigger in interactive mode", () => {
    const interactiveFloat = resolveRobotSequence({
      slot: "idle",
      action: { ...DEFAULT_ROBOT_ACTION, idle: "float" },
      animationEnabled: true,
      trigger: "interactive",
      hovered: false,
    });
    expect(interactiveFloat.active).toBe(false);

    const alwaysFloat = resolveRobotSequence({
      slot: "idle",
      action: { ...DEFAULT_ROBOT_ACTION, idle: "float" },
      animationEnabled: true,
      trigger: "always",
      hovered: false,
    });
    expect(alwaysFloat.active).toBe(true);
  });

  it("respects per-reactive toggle for done/hover/reminder", () => {
    const doneDisabled = resolveRobotSequence({
      slot: "done",
      action: { ...DEFAULT_ROBOT_ACTION, done: false },
      animationEnabled: true,
      trigger: "always",
      hovered: false,
    });
    expect(doneDisabled.active).toBe(false);

    const doneEnabled = resolveRobotSequence({
      slot: "done",
      action: { ...DEFAULT_ROBOT_ACTION, done: true },
      animationEnabled: true,
      trigger: "interactive",
      hovered: false,
    });
    expect(doneEnabled.active).toBe(true);
    expect(doneEnabled.playback).toBe("once");
  });
});
