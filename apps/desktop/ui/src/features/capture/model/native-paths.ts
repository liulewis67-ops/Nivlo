import { listen } from "@tauri-apps/api/event";

/** 宿主把路径发回来的事件名（与后端 `native_drop::EVENT` 一致）。 */
const EVENT = "stardeskbox-drop-paths";

/** 等宿主回路径的最长时间（毫秒）。 */
const TIMEOUT_MS = 1500;

/** WebView2 注入的 `chrome.webview` 的最小形状。 */
type WebView2Bridge = {
  postMessageWithAdditionalObjects?: (message: string, objects: ArrayLike<unknown>) => void;
};

/**
 * 取出 WebView2 的消息桥；不在 WebView2 里（浏览器预览、测试）时为 `null`。
 *
 * @returns 消息桥或 `null`。
 */
function bridge(): WebView2Bridge | null {
  const chrome = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome;
  const webview = chrome?.webview;
  return typeof webview?.postMessageWithAdditionalObjects === "function" ? webview : null;
}

/**
 * 向宿主索要拖入文件的磁盘路径。
 *
 * HTML5 Drop 里的 `File` 没有路径；WebView2 允许把 `File` 对象连同一条消息交给宿主，
 * 宿主从中取出磁盘路径再用事件发回来（实施计划 10.1）。只能对用户真正拖入的 `File` 使用，
 * 页面无法借此读取任意路径。
 *
 * @param files 拖入的文件。
 * @param post 测试注入：代替真实的消息桥。
 * @returns 与 `files` 顺序一致的磁盘路径；不在 WebView2 里、超时或宿主没有给出路径时为 `null`。
 */
export async function requestFilePaths(
  files: readonly File[],
  post: WebView2Bridge | null = bridge(),
): Promise<string[] | null> {
  if (post === null || post.postMessageWithAdditionalObjects === undefined || files.length === 0) {
    return null;
  }
  const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let unlisten: (() => void) | undefined;
  try {
    const reply = new Promise<string[] | null>((resolve) => {
      const timer = window.setTimeout(() => resolve(null), TIMEOUT_MS);
      void listen<{ id: string; paths: string[] }>(EVENT, (event) => {
        if (event.payload.id !== id) return;
        window.clearTimeout(timer);
        resolve(event.payload.paths.length > 0 ? event.payload.paths : null);
      }).then((stop) => {
        unlisten = stop;
        // 先登记监听再发消息，避免回复先于监听到达。
        post.postMessageWithAdditionalObjects?.(`stardeskbox:drop-files:${id}`, [...files]);
      });
    });
    return await reply;
  } catch {
    return null;
  } finally {
    unlisten?.();
  }
}
