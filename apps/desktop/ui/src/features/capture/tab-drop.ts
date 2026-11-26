import { listen } from "@tauri-apps/api/event";
import type { DropSnapshot } from "./model/extract-drop";

/** 宿主发来的事件名（与后端 `tab_drop::EVENT` 一致）。 */
const EVENT = "stardeskbox-tab-drop";

/** 宿主发来的事件内容。 */
export type TabDropPayload = {
  /** 页面网址。 */
  url: string;
  /** 页面标题；认不出时为 `null`。 */
  title: string | null;
  /** 松手位置（页面坐标，逻辑像素）。 */
  x: number;
  /** 同上。 */
  y: number;
};

/**
 * 把标签页拖入变成与普通拖放相同的快照：网址放在 `text/uri-list`，标题按 Firefox 的
 * `text/x-moz-url` 格式（网址一行、标题一行）附上，后续的提取规则无需区分来源。
 *
 * @param payload 宿主发来的内容。
 * @returns 拖放快照。
 */
export function tabDropSnapshot(payload: TabDropPayload): DropSnapshot {
  return {
    uriList: payload.url,
    mozUrl: payload.title === null ? "" : `${payload.url}\n${payload.title}`,
    text: payload.url,
    html: "",
    files: [],
  };
}

/**
 * 订阅「浏览器标签页拖到悬浮窗上」。Chromium 浏览器拖动标签页不是系统拖放，页面收不到 `drop`；
 * 宿主识别到松手的位置在悬浮窗上后读出网址发过来（仅 Windows）。
 *
 * @param handle 收到一次拖入时调用：快照与松手位置。
 * @returns 取消订阅。
 */
export function subscribeTabDrops(
  handle: (snapshot: DropSnapshot, point: { x: number; y: number }) => void,
): () => void {
  let stop: (() => void) | undefined;
  let cancelled = false;
  listen<TabDropPayload>(EVENT, (event) => {
    handle(tabDropSnapshot(event.payload), { x: event.payload.x, y: event.payload.y });
  })
    .then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    })
    .catch(() => {
      // 不在 Tauri 里（浏览器预览、测试）：没有标签页拖入可收。
    });
  return () => {
    cancelled = true;
    stop?.();
  };
}
