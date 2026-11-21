/**
 * 把一串连续的信号合并：第一个信号立即执行 `run`，之后 `windowMs` 内到达的信号只记一笔，
 * 窗口结束时如果有新信号再执行一次（领先 + 尾随）。
 *
 * 用于后端的数据变化事件：批量整理 / 恢复 / 删除 N 个 Item 会连续到达 N 个事件，
 * 逐个处理会让每个可见查询重取 N 次；合并后单次操作没有任何额外延迟，一串事件最多重取两轮。
 *
 * @param run 要执行的回调。
 * @param windowMs 合并窗口（毫秒）。
 * @returns `signal` 发出一个信号；`cancel` 丢弃尚未执行的尾随调用（卸载时调用）。
 */
export function coalesce(
  run: () => void,
  windowMs: number,
): { signal: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  /** 窗口结束：有积压的信号就执行一次并开下一个窗口，否则回到空闲。 */
  const close = () => {
    if (pending) {
      pending = false;
      run();
      // 尾随执行之后再开一个窗口，持续不断的事件流也只会每个窗口执行一次。
      timer = setTimeout(close, windowMs);
    } else {
      timer = undefined;
    }
  };

  return {
    signal: () => {
      if (timer === undefined) {
        run();
        timer = setTimeout(close, windowMs);
      } else {
        pending = true;
      }
    },
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = false;
    },
  };
}
