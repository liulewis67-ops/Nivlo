import { useEffect, useState, useSyncExternalStore } from "react";
import { createFloatingMachine } from "./model/floating-machine";
import type { FloatingEvent, FloatingState } from "./model/floating-machine";

/**
 * 在组件中使用悬浮窗状态机。
 *
 * 状态机在首次渲染时创建，卸载时清除其所有计时器（前端规范 §9：Timer 必须在卸载时清除）。
 * 状态订阅使用 `useSyncExternalStore`，状态没变化时不会触发重渲染。
 *
 * @returns 当前状态与投递事件的函数。
 */
export function useFloatingMachine(): {
  state: FloatingState;
  send: (event: FloatingEvent) => void;
} {
  const [machine] = useState(() => createFloatingMachine());
  useEffect(() => () => machine.dispose(), [machine]);
  const state = useSyncExternalStore(machine.subscribe, machine.getState);
  return { state, send: machine.send };
}
