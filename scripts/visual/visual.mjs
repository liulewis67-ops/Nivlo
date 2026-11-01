#!/usr/bin/env node
// 视觉回归（实施计划 11.1）：用真实的 Chrome（无头）打开浏览器预览（内存版 IPC，数据固定），
// 对关键页面截图，与 `tests/visual/baselines/<平台>/` 里的基线逐像素对比。
//
// 用法：
//   node scripts/visual/visual.mjs            对比；有差异时退出码 1，并把差异图写到 tests/visual/diff/
//   node scripts/visual/visual.mjs --update   重新生成基线
//
// 基线按平台分目录（字体与渲染随操作系统不同，不能跨平台共用）。需要 Chrome / Chromium：
// 设置环境变量 CHROME 指定路径，否则按常见位置查找。预览服务器默认自己启动（pnpm dev:ui）。

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLATFORM = process.platform;
const IMPLEMENTATION = process.argv.includes("--implementation-baseline");
const BASELINES = IMPLEMENTATION
  ? join(ROOT, "tests", "visual", "implementation-baseline")
  : join(ROOT, "tests", "visual", "baselines", PLATFORM);
const DIFFS = join(ROOT, "tests", "visual", "diff");
const UPDATE = process.argv.includes("--update");
const APP = "http://localhost:1420";
/** 允许的像素差异比例（抗锯齿 / 亚像素差异）。 */
const MAX_DIFF_RATIO = 0.002;
const CLOCK = "2026-10-13T04:00:00.000Z";

/** 找 Chrome。 */
function chromePath() {
  const candidates = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("找不到 Chrome / Chromium，请设置 CHROME 环境变量");
  return found;
}

/** 等待 URL 可访问。 */
async function waitFor(url, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待 ${url} 超时`);
}

/** 一个 CDP 会话。 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++n;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.error || r.result?.exceptionDetails) throw new Error(JSON.stringify(r.error ?? r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 点击页面上文本匹配的按钮。 */
const clickText = (page, text) =>
  page.evaluate(`(() => { const b=[...document.querySelectorAll('button,[role=button],a')].find(x=>x.textContent.trim()===${JSON.stringify(text)} || [...x.children].some(c=>c.tagName==='SPAN' && c.textContent.trim()===${JSON.stringify(text)})); if(!b) return false; b.click(); return true; })()`);

/** 场景：名称、视口、地址、截图前的步骤。 */
const SCENARIOS = [
  { name: "floating-collapsed", w: 64, h: 32, url: `${APP}/?window=floating`, steps: async () => sleep(800) },
  {
    name: "floating-expanded",
    w: 380,
    h: 520,
    url: `${APP}/?window=floating`,
    steps: async (page) => {
      await sleep(600);
      // 真实的指针悬停才会展开（悬浮窗状态机按 pointerenter + 延时判断）。
      const box = await page.evaluate("(() => { const r = document.querySelector('button').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
      const [x, y] = box;
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 40, y: y - 40 });
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(1500);
    },
  },
  { name: "main-today", w: 1100, h: 720, url: APP, steps: async (page) => { await sleep(900); await clickText(page, "今天"); await sleep(600); } },
  { name: "main-inbox", w: 1100, h: 720, url: APP, steps: async (page) => { await sleep(900); await clickText(page, "收集箱"); await sleep(600); } },
  { name: "main-calendar", w: 1100, h: 720, url: APP, steps: async (page) => { await sleep(900); await clickText(page, "日历"); await sleep(900); } },
  {
    name: "main-today-dark",
    w: 1100,
    h: 720,
    url: APP,
    steps: async (page) => {
      await page.evaluate("document.documentElement.dataset.theme='dark'");
      await sleep(900);
      await clickText(page, "今天");
      await sleep(600);
    },
  },
];

// 实施前的独立证据集，不覆盖历史视觉回归基线。
if (IMPLEMENTATION) {
  for (const [route, label] of Object.entries({ inbox: "收集箱", today: "今天", calendar: "日历", notes: "笔记", projects: "项目", workflows: "自动化", trash: "回收站", settings: "设置" })) {
    SCENARIOS.push({ name: `baseline-${route}`, w: 960, h: 640, url: APP, steps: async (page) => {
      if (!await clickText(page, label)) throw new Error(`Missing route: ${label}`);
      await sleep(700);
    } });
  }
  SCENARIOS.push({ name: "baseline-inbox-detail", w: 960, h: 640, url: APP, steps: async (page) => {
    await clickText(page, "收集箱");
    await sleep(500);
    const opened = await page.evaluate("(() => { const button = document.querySelector('main li button.text-left'); if (!button) return false; button.click(); return true; })()");
    if (!opened) throw new Error("Missing Inbox detail trigger");
    await sleep(700);
  } });
  SCENARIOS.push({ name: "baseline-todo-detail", w: 960, h: 640, url: APP, steps: async (page) => {
    await clickText(page, "收集箱");
    await sleep(500);
    if (!await clickText(page, "记得给新来的同事开通测试环境的权限")) throw new Error("Missing Todo detail trigger");
    await sleep(700);
  } });
  SCENARIOS.push({ name: "baseline-calendar-dense", w: 960, h: 640, url: APP, steps: async (page) => {
    await page.evaluate(`(async () => {
      const { ipc } = await import('/src/lib/ipc.ts');
      for (let i = 0; i < 20; i++) await ipc.createItem({
        itemType: ['todo', 'note', 'tip'][i % 3], title: 'Same prefix calendar / 相同前缀日程 ' + String(i + 1).padStart(2, '0'),
        content: null, contentFormat: 'plain', priority: null, projectId: null, reminderAt: null,
        scheduled: { date: '2026-10-13', time: i % 2 ? '15:00:00' : null },
        due: i % 3 === 0 ? { date: '2026-10-13', time: null } : null
      });
    })()`);
    await clickText(page, "日历");
    await sleep(700);
  } });
  SCENARIOS.push({ name: "baseline-search", w: 640, h: 440, url: `${APP}/?window=search`, steps: async () => sleep(700) });
}

/** 跳过引导对话框 / 动画：关闭动效，让截图稳定。 */
const STABILIZE = `
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
  document.head.appendChild(s);
`;

async function main() {
  mkdirSync(BASELINES, { recursive: true });
  let server = null;
  try {
    await waitFor(APP, 1500);
  } catch {
    server = spawn("pnpm", ["dev:ui"], { cwd: ROOT, shell: true, stdio: "ignore" });
    await waitFor(APP);
  }
  const profile = mkdtempSync(join(tmpdir(), "nivlo-visual-"));
  const chrome = spawn(chromePath(), [
    "--headless=new",
    "--remote-debugging-port=9333",
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--disable-gpu",
    "--no-first-run",
    "about:blank",
  ], { stdio: "ignore" });
  await waitFor("http://127.0.0.1:9333/json/version");

  let failed = 0;
  const artifacts = [];
  try {
    for (const scenario of SCENARIOS) {
      const created = await (await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
      const page = await connect(created.webSocketDebuggerUrl);
      await page.send("Emulation.setDeviceMetricsOverride", { width: scenario.w, height: scenario.h, deviceScaleFactor: 1, mobile: false });
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
      await page.send("Page.enable");
      if (IMPLEMENTATION) {
        await page.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" });
        await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `
          localStorage.clear();
          localStorage.setItem('nivlo.language', 'zh-CN');
          localStorage.setItem('nivlo.theme', 'light');
          const OriginalDate = Date;
          window.Date = class extends OriginalDate {
            constructor(...args) { super(...(args.length ? args : [${JSON.stringify(CLOCK)}])); }
            static now() { return new OriginalDate(${JSON.stringify(CLOCK)}).getTime(); }
          };
          let fixtureId = 0;
          crypto.randomUUID = () => '00000000-0000-4000-8000-' + String(++fixtureId).padStart(12, '0');
        ` });
      }
      // 把引导对话框标记成已看过，避免它盖住页面。
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('nivlo.onboarding','done')" });
      await page.send("Page.navigate", { url: scenario.url });
      await sleep(1200);
      await page.evaluate(STABILIZE);
      await scenario.steps(page);
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      const actual = Buffer.from(shot.result.data, "base64");
      const file = join(BASELINES, `${scenario.name}.png`);
      if (IMPLEMENTATION || UPDATE || !existsSync(file)) {
        writeFileSync(file, actual);
        console.log(`${UPDATE ? "更新" : "新建"}基线：${scenario.name}`);
      } else {
        const a = PNG.sync.read(readFileSync(file));
        const b = PNG.sync.read(actual);
        if (a.width !== b.width || a.height !== b.height) {
          console.error(`✗ ${scenario.name}：尺寸不同（基线 ${a.width}x${a.height}，当前 ${b.width}x${b.height}）`);
          failed += 1;
        } else {
          const diff = new PNG({ width: a.width, height: a.height });
          const count = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
          const ratio = count / (a.width * a.height);
          if (ratio > MAX_DIFF_RATIO) {
            mkdirSync(DIFFS, { recursive: true });
            writeFileSync(join(DIFFS, `${scenario.name}.diff.png`), PNG.sync.write(diff));
            writeFileSync(join(DIFFS, `${scenario.name}.actual.png`), actual);
            console.error(`✗ ${scenario.name}：${(ratio * 100).toFixed(2)}% 像素不同（见 tests/visual/diff/）`);
            failed += 1;
          } else {
            console.log(`✓ ${scenario.name}（差异 ${(ratio * 100).toFixed(3)}%）`);
          }
        }
      }
      if (IMPLEMENTATION) artifacts.push({
        name: scenario.name, file: `${scenario.name}.png`, viewport: { width: scenario.w, height: scenario.h },
        ...await page.evaluate(`({ locale: document.documentElement.lang, theme: document.documentElement.dataset.theme,
          userAgent: navigator.userAgent, devicePixelRatio, clock: new Date().toISOString(),
          pageOverflow: document.documentElement.scrollWidth > innerWidth })`),
        sha256: createHash("sha256").update(actual).digest("hex"),
      });
      page.close();
      await fetch(`http://127.0.0.1:9333/json/close/${created.id}`);
    }
  } finally {
    chrome.kill();
    if (server) {
      // Windows 的 shell 子进程退出不会自动关闭 pnpm/Vite 子树。
      if (process.platform === "win32" && server.pid) {
        try { execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" }); }
        catch { /* 已经退出时无需再次关闭。 */ }
      } else server.kill();
    }
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  }
  if (IMPLEMENTATION) writeFileSync(join(BASELINES, "manifest.json"), JSON.stringify({
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    branch: execFileSync("git", ["branch", "--show-current"], { cwd: ROOT, encoding: "utf8" }).trim(),
    fixtureRevision: "w0-v1: dev-seed + 20 similar-prefix calendar entries", clock: CLOCK,
    platform: PLATFORM, timezone: "Asia/Shanghai", motion: "reduce; animations/transitions disabled",
    environment: "Chrome browser mock; OS scale and native WebView2 not certified", artifacts,
  }, null, 2) + "\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
