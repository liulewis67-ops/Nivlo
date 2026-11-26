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
import { guidanceScenes } from "./guidance-scenes.mjs";
import { accessibilityAudit } from "./accessibility-audit.mjs";
import { releaseScenes } from "./release-scenes.mjs";
import { createConfigurationScenes } from "./create-configuration-scenes.mjs";
import { attachmentScenes } from "./attachment-scenes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLATFORM = process.platform;
const DETAIL_STAGE = process.argv.includes("--detail-stage");
const CALENDAR_STAGE = process.argv.includes("--calendar-stage");
const FOCUS_AUDIT = process.argv.includes("--search-focus-audit");
const GUIDANCE_STAGE = process.argv.includes("--guidance-stage");
const ACCESSIBILITY_STAGE = process.argv.includes("--accessibility-stage");
const RELEASE_STAGE = process.argv.includes("--release-stage");
const CREATE_STAGE = process.argv.includes("--create-stage");
const ATTACHMENT_STAGE = process.argv.includes("--attachment-stage");
const releaseMeasurements = [];
let contrastFailures = 0;
const IMPLEMENTATION = process.argv.includes("--implementation-baseline") || DETAIL_STAGE || CALENDAR_STAGE || FOCUS_AUDIT || GUIDANCE_STAGE || ACCESSIBILITY_STAGE || RELEASE_STAGE;
const BASELINES = (ATTACHMENT_STAGE || DETAIL_STAGE) ? join(ROOT,"tests","visual","stages","attachments") : CREATE_STAGE ? join(ROOT,"apps","desktop","ui",".impeccable","review") : RELEASE_STAGE ? join(ROOT,"tests","visual","stages","m5") : ACCESSIBILITY_STAGE ? join(ROOT,"tests","visual","stages","m4") : GUIDANCE_STAGE ? join(ROOT, "tests", "visual", "stages", "m3") : FOCUS_AUDIT ? join(ROOT, "tests", "visual", "stages", "m3", "before-focus") : CALENDAR_STAGE ? join(ROOT, "tests", "visual", "stages", "m2") : DETAIL_STAGE ? join(ROOT, "tests", "visual", "stages", "m1") : IMPLEMENTATION
  ? join(ROOT, "tests", "visual", "implementation-baseline")
  : join(ROOT, "tests", "visual", "baselines", PLATFORM);
const DIFFS = join(ROOT, "tests", "visual", "diff");
const UPDATE = process.argv.includes("--update");
const ONLY_SCENE = process.argv.includes("--scene") ? process.argv[process.argv.indexOf("--scene")+1] : null;
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
  const listeners = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
    if (d.method) listeners.get(d.method)?.(d.params);
  };
  const send = (method, params = {}) =>
    new Promise((res, reject) => {
      const id = ++n;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, 30000);
      pending.set(id, result => { clearTimeout(timeout); res(result); });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.error || r.result?.exceptionDetails) throw new Error(JSON.stringify(r.error ?? r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { send, evaluate, on: (method, listener) => listeners.set(method, listener), close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 点击页面上文本匹配的按钮。 */
const clickText = (page, text) =>
  page.evaluate(`(() => { const b=[...document.querySelectorAll('button,[role=button],a')].find(x=>x.textContent.trim()===${JSON.stringify(text)} || [...x.children].some(c=>c.tagName==='SPAN' && c.textContent.trim()===${JSON.stringify(text)})); if(!b) return false; b.click(); return true; })()`);

/** 在开发服务器 / React 提交完成前等待可操作的目标，不重复已经成功的动作。 */
async function clickWhenReady(page, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await clickText(page, label)) return;
    await sleep(100);
  }
  throw new Error(`Missing action ${label}: ${await page.evaluate("document.body.innerText.slice(0, 500)")}`);
}

/** 场景：名称、视口、地址、截图前的步骤。 */
const SCENARIOS = [
  {
    name: "floating-collapsed", w: 80, h: 40, url: `${APP}/?window=floating`,
    steps: async (page) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await page.evaluate("Boolean(document.querySelector('[data-shape=robot] .nv-robot-counter'))")) return;
        await sleep(100);
      }
      throw new Error("Floating robot and count did not render");
    },
  },
  {
    name: "floating-expanded",
    w: 300,
    h: 380,
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
if (IMPLEMENTATION && !RELEASE_STAGE) {
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

// M1 的独立验收集；不覆盖 W0 或历史回归图片。
if (RELEASE_STAGE) {
  SCENARIOS.length = 0;
  for (const scene of [
    { name: "detail-960-light-zh", w: 960, h: 640 },
    { name: "detail-960-dark-en", w: 960, h: 640, dark: true, en: true },
    { name: "detail-1280-light-en", w: 1280, h: 800, en: true },
    { name: "detail-400-dark-zh", w: 400, h: 600, dark: true },
    { name: "detail-resize-saving", w: 1280, h: 800, resize: true },
    { name: "detail-failed-close", w: 960, h: 640, fail: true },
    { name: "detail-scrolled-failure", w: 960, h: 640, fail: true, content: true, en: true },
  ]) SCENARIOS.push({ ...scene, url: APP, steps: async (page) => {
    for (let attempt = 0; !await page.evaluate("!!document.querySelector('main')"); attempt++) {
      if (attempt >= 100) throw new Error("Main shell did not become ready");
      await sleep(100);
    }
    await page.evaluate(`import('/src/i18n/index.ts').then(m => m.setLanguage('${scene.en ? "en" : "zh-CN"}'))`);
    if (scene.dark) await page.evaluate("import('/src/stores/theme-store.ts').then(m => m.useThemeStore.getState().setPreference('dark'))");
    if (scene.w < 800) { await clickWhenReady(page, "导航"); await sleep(100); }
    await clickWhenReady(page, scene.en ? "Inbox" : "收集箱");
    await sleep(400);
    await clickWhenReady(page, "记得给新来的同事开通测试环境的权限");
    await sleep(400);
    if (scene.name === "detail-960-light-zh") {
      // 默认尺寸下直接安排日期，不先经过描述；另存实际浏览器帧的录像。
      await page.evaluate(`(() => {
        const input = document.querySelector('.nv-detail-panel input[type=date]');
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2026-10-15');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(900);
      if (!await page.evaluate(`(async () => {
        const { ipc } = await import('/src/lib/ipc.ts');
        const { useNavStore } = await import('/src/features/shell/nav-store.ts');
        const item = await ipc.getItem(useNavStore.getState().detailId);
        return item.scheduled?.date === '2026-10-15' && item.due === null;
      })()`)) throw new Error("Default-size scheduling did not persist, or altered due");
    }
    if (scene.resize || scene.fail) {
      await page.evaluate(`(async () => {
        const { ipc } = await import('/src/lib/ipc.ts');
        const update = ipc.updateItem;
        ${scene.fail ? `const { AppError } = await import('/src/lib/errors.ts'); ipc.updateItem = async () => { throw new AppError('STORAGE_UNAVAILABLE', 'injected'); };` : `ipc.updateItem = async (...args) => { await new Promise(resolve => window.__releaseDetailSave = resolve); return update(...args); };`}
        window.__detailTitle = document.querySelector('.nv-detail-panel ${scene.content ? "textarea" : "input"}');
        window.__detailTitle.focus(); window.__detailTitle.select();
      })()`);
      await page.send("Input.insertText", { text: "Resize / failed-save draft" });
      if (scene.fail) await page.evaluate("document.querySelector('.nv-detail-panel header button[aria-label]').click()");
      else {
        await sleep(850);
        await page.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
        await sleep(200);
        const stable = await page.evaluate("window.__detailTitle === document.querySelector('.nv-detail-panel input') && document.querySelector('.nv-detail-panel').getAttribute('aria-modal') === 'true' && typeof window.__releaseDetailSave === 'function'");
        if (!stable) throw new Error("Resize remounted or lost the pending editor");
        await page.send("Emulation.setDeviceMetricsOverride", { width: scene.w, height: scene.h, deviceScaleFactor: 1, mobile: false });
        await page.evaluate("window.__releaseDetailSave()");
      }
      await sleep(500);
    }
    const checks = await page.evaluate(`(() => {
      const panel = document.querySelector('.nv-detail-panel');
      const dates = [...panel.querySelectorAll('input[type=date]')];
      return { noOverflow: document.documentElement.scrollWidth <= innerWidth,
        datesReachable: dates.length === 2 && ${scene.content ? "true" : "dates.every(x => x.getBoundingClientRect().bottom <= innerHeight)"},
        expectedModal: panel.getAttribute('aria-modal') === (innerWidth < 1200 ? 'true' : null),
        backgroundInert: document.querySelector('main').inert === (innerWidth < 1200),
        draftPreserved: ${scene.resize || scene.fail ? `panel.querySelector('${scene.content ? "textarea" : "input"}').value === 'Resize / failed-save draft'` : "true"},
        failureRecoverable: ${scene.fail ? "!!panel.querySelector('[role=alert]') && panel.querySelector('[role=alert]').getBoundingClientRect().top >= 0 && panel.querySelector('[role=alert]').getBoundingClientRect().bottom <= innerHeight" : "true"}
      };
    })()`);
    if (Object.values(checks).some(value => !value)) throw new Error(`Detail checks failed: ${JSON.stringify(checks)}`);
  } });
}

if (CALENDAR_STAGE || RELEASE_STAGE) {
  if (!RELEASE_STAGE) SCENARIOS.length = 0;
  for (const scene of [
    { name: "calendar-960-month-zh", w: 960, h: 640 },
    { name: "calendar-960-week-en-dark", w: 960, h: 640, en: true, dark: true, week: true },
    { name: "calendar-960-tooltip-focus", w: 960, h: 640, week: true, tooltip: true },
    { name: "calendar-400-week-en", w: 400, h: 600, en: true, week: true },
    { name: "calendar-1440-docked-zh", w: 1440, h: 800 },
    { name: "calendar-960-backlog-en-dark", w: 960, h: 640, en: true, dark: true, backlog: true },
    { name: "calendar-keyboard-schedule", w: 960, h: 640, keyboard: true },
    { name: "calendar-create-failure", w: 960, h: 640, failure: true },
  ]) SCENARIOS.push({ ...scene, url: APP, steps: async (page) => {
    await page.evaluate(`import('/src/i18n/index.ts').then(m => m.setLanguage('${scene.en ? "en" : "zh-CN"}'))`);
    if (scene.dark) await page.evaluate("import('/src/stores/theme-store.ts').then(m => m.useThemeStore.getState().setPreference('dark'))");
    await page.evaluate(`(async () => {
      const { ipc } = await import('/src/lib/ipc.ts');
      for (let i = 1; i <= 20; i++) await ipc.createItem({ itemType: 'todo', title: '相同前缀 / Similar title — calendar task ' + String(i).padStart(2, '0'), content: null, contentFormat: 'plain', priority: null, reminderAt: null, projectId: null, scheduled: { date: '2026-10-13', time: i % 2 ? '15:00:00' : null }, due: i === 1 ? { date: '2026-10-15', time: null } : null });
    })()`);
    if (scene.w < 800) await clickWhenReady(page, scene.en ? "Navigation" : "导航");
    await clickWhenReady(page, scene.en ? "Calendar" : "日历");
    await sleep(500);
    if (scene.week) {
      await page.evaluate(`(() => { const b = document.querySelector('[data-calendar-day="2026-10-13"] [role=region] button:last-child'); b.scrollIntoView({block:'nearest'}); b.click(); })()`);
      await sleep(500);
      if (!await page.evaluate(`[...document.querySelector('[data-calendar-day="2026-10-13"] [role=region]').querySelectorAll('button')].filter(b => b.textContent.includes('Similar title')).length === 20`)) throw new Error('Dense week did not expose all twenty items');
    }
    if (scene.tooltip) {
      await page.send("Page.bringToFront");
      await page.evaluate(`document.querySelector('[data-calendar-day="2026-10-13"] button[aria-label*="Similar title"]').focus({preventScroll:true})`);
      await sleep(600);
      if (!await page.evaluate(`document.querySelector('[role=tooltip]')?.textContent.includes('Similar title')`)) throw new Error(`Full identity tooltip did not appear on focus: ${await page.evaluate('document.hasFocus() + document.activeElement.outerHTML')}`);
    }
    if (!scene.week && !scene.backlog && !scene.keyboard && !scene.failure) {
      if (!await page.evaluate(`(() => { const region = document.querySelector('[data-calendar-day="2026-10-13"] [role=region]'); const more = region.querySelector('button:last-child'); return more.getBoundingClientRect().bottom <= region.getBoundingClientRect().bottom + 1; })()`)) throw new Error('Dense month overflow action is clipped');
    }
    if (scene.backlog || scene.keyboard) {
      await page.evaluate(`(() => { const b = [...document.querySelectorAll('main header button')].find(b => b.textContent.includes('${scene.en ? "Unscheduled" : "待安排"}')); b.focus(); window.__backlogTrigger = b; window.__gridWidth = document.querySelector('[role=grid]').getBoundingClientRect().width; b.click(); })()`);
      await sleep(300);
      if (!await page.evaluate(`document.querySelector('dialog').matches(':modal') && document.querySelector('[role=grid]').getBoundingClientRect().width === window.__gridWidth`)) throw new Error('Backlog is not modal or compressed the grid');
      // Top-layer containment must prevent even scripted background focus.
      if (!await page.evaluate(`(() => { window.__backlogTrigger.focus(); return document.querySelector('dialog').contains(document.activeElement); })()`)) throw new Error('Backlog background accepted focus');
      if (scene.backlog) {
        await page.evaluate(`document.querySelector('dialog li button').focus()`);
        await sleep(500);
        if (!await page.evaluate(`!!document.querySelector('dialog [role=tooltip]')`)) throw new Error('Backlog tooltip not contained: '+JSON.stringify(await page.evaluate(`({focus:document.hasFocus(),active:document.activeElement?.outerHTML,tooltips:[...document.querySelectorAll('[role=tooltip]')].map(e=>({text:e.textContent,inDialog:!!e.closest('dialog')}))})`)));
      }
      if (scene.keyboard) {
        await page.evaluate(`document.querySelector('dialog li button').focus()`);
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        for (let attempt = 0; !await page.evaluate("!!document.querySelector('.nv-detail-panel input[type=date]')"); attempt++) {
          if (attempt > 30) throw new Error(`Keyboard open failed: ${await page.evaluate("document.activeElement?.outerHTML + document.body.innerText.slice(-600)")}`);
          await sleep(100);
        }
        await page.evaluate(`(() => { const input = document.querySelector('.nv-detail-panel input[type=date]'); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2026-10-16'); input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
        await sleep(900);
        if (!await page.evaluate(`(async () => { const { ipc } = await import('/src/lib/ipc.ts'); const { useNavStore } = await import('/src/features/shell/nav-store.ts'); return (await ipc.getItem(useNavStore.getState().detailId)).scheduled.date === '2026-10-16'; })()`)) throw new Error('Keyboard detail schedule did not persist');
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(300);
        if (!await page.evaluate(`document.activeElement === window.__backlogTrigger && !document.querySelector('[aria-modal=true]')`)) throw new Error('Keyboard return did not restore toolbar');
      }
    }
    if (scene.failure) {
      await page.evaluate(`(async () => { const { ipc } = await import('/src/lib/ipc.ts'); const { AppError } = await import('/src/lib/errors.ts'); ipc.createItem = async () => { throw new AppError('STORAGE_UNAVAILABLE', 'injected'); }; document.querySelector('[data-calendar-day="2026-10-13"] [data-day-add]').click(); })()`);
      await page.send('Input.insertText', { text: 'Creation must retain this draft' });
      await page.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
      await page.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
      await sleep(300);
      if (!await page.evaluate(`document.querySelector('input[aria-label="新待办"]').value === 'Creation must retain this draft'`)) throw new Error('Failed create lost draft');
    }
    if (!await page.evaluate('document.documentElement.scrollWidth <= innerWidth')) throw new Error('Calendar page overflows horizontally');
  } });
}

if (FOCUS_AUDIT) {
  SCENARIOS.length = 0;
  for (const method of ['click', 'shortcut']) SCENARIOS.push({ name: `search-focus-${method}`, w: 960, h: 640, url: APP, steps: async (page) => {
    await page.send('Page.bringToFront');
    await clickWhenReady(page, '收集箱');
    await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Ctrl K')); b.focus(); ${method === 'click' ? 'b.click();' : ''} })()`);
    if (method === 'shortcut') {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
    }
    await sleep(300);
    const before = await page.evaluate(`({ inputFocused: document.activeElement === document.querySelector('[role=combobox]'), active: document.activeElement?.outerHTML.slice(0,600) })`);
    await page.send('Input.insertText', { text: 'focus audit' });
    const after = await page.evaluate(`document.querySelector('[role=combobox]')?.value`);
    writeFileSync(join(BASELINES, `search-focus-${method}.json`), JSON.stringify({ method, ...before, immediateTyping: after === 'focus audit', browserOnly: true }, null, 2));
  } });
}

if (GUIDANCE_STAGE) {
  SCENARIOS.length = 0;
  SCENARIOS.push(...guidanceScenes({ app: APP, click: clickWhenReady, sleep }));
}

if (ACCESSIBILITY_STAGE) {
  SCENARIOS.length=0;
  const scenes=guidanceScenes({app:APP,click:clickWhenReady,sleep});
  const failedUndo=scenes.find(scene=>scene.name==='guidance-global-error-undo-zh');
  scenes.push({...failedUndo,name:'guidance-global-error-undo-320-zh',w:320,h:220});
  SCENARIOS.push(...scenes.map(scene=>({...scene,steps:async page=>{
    await scene.steps(page);
    if (scene.name === 'guidance-global-zh' || scene.name === 'guidance-palette-zh') {
      await page.evaluate(`document.querySelector('button[aria-pressed="true"]').click()`);
      await sleep(200);
    }
    const audit=await accessibilityAudit(page);
    contrastFailures += audit.failures.length;
    writeFileSync(join(BASELINES,scene.name+'.accessibility.json'),JSON.stringify(audit,null,2)+'\n');
    console.log(scene.name+': '+audit.samples.length+' contrast samples, '+audit.failures.length+' failures, '+audit.unmeasured.length+' gradient samples unmeasured');
    if(scene.name==='guidance-global-error-undo-320-zh') {
      const bounds=await page.evaluate(`({height:innerHeight,footer:document.querySelector('footer').getBoundingClientRect().bottom,alert:document.querySelector('[role=alert]').getBoundingClientRect().bottom})`);
      if(bounds.footer>bounds.height+1||bounds.alert>bounds.height+1)throw Error('Compact search recovery clipped: '+JSON.stringify(bounds));
    }
  }})));
}

if (RELEASE_STAGE) {
  SCENARIOS.push(...guidanceScenes({app:APP,click:clickWhenReady,sleep}));
  SCENARIOS.push(...releaseScenes({app:APP,click:clickWhenReady,sleep,record:(scene,value)=>releaseMeasurements.push({scene,...value})}));
}

if (ATTACHMENT_STAGE || DETAIL_STAGE) {
  SCENARIOS.length = 0;
  SCENARIOS.push(...attachmentScenes({ app: APP, sleep }));
}

if (CREATE_STAGE) {
  SCENARIOS.length = 0;
  SCENARIOS.push(...createConfigurationScenes({ app: APP, sleep }));
}

async function main() {
  mkdirSync(BASELINES, { recursive: true });
  let server = null;
  try {
    await waitFor(APP, 1500);
  } catch {
    server = spawn("pnpm", ["dev:ui"], { cwd: ROOT, shell: true, stdio: "ignore" });
    await waitFor(APP);
  }
  const profile = mkdtempSync(join(tmpdir(), "stardeskbox-visual-"));
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
  const recordings = [];
  try {
    for (const scenario of SCENARIOS.filter(scene=>!ONLY_SCENE||scene.name===ONLY_SCENE)) {
      const created = await (await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
      const page = await connect(created.webSocketDebuggerUrl);
      await page.send("Emulation.setDeviceMetricsOverride", { width: scenario.w, height: scenario.h, deviceScaleFactor: 1, mobile: false });
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
      await page.send("Page.enable");
      if (CALENDAR_STAGE || GUIDANCE_STAGE || FOCUS_AUDIT || ACCESSIBILITY_STAGE) await page.send("Page.bringToFront");
      {
        await page.send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" });
        await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `
          localStorage.clear();
          localStorage.setItem('stardeskbox.language', 'zh-CN');
          localStorage.setItem('stardeskbox.theme', 'light');
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
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('stardeskbox.onboarding','done')" });
      await page.send("Page.navigate", { url: scenario.url });
      await page.send("Page.bringToFront");
      await sleep(1200);
      await page.evaluate(STABILIZE);
      const frames = [];
      const record = DETAIL_STAGE && scenario.name === "detail-960-light-zh";
      if (record) {
        page.on("Page.screencastFrame", (frame) => {
          frames.push({ data: Buffer.from(frame.data, "base64"), timestamp: frame.metadata.timestamp });
          void page.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
        });
        await page.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 960, maxHeight: 640, everyNthFrame: 1 });
        await sleep(300);
      }
      try { await scenario.steps(page); }
      catch(error) {
        mkdirSync(DIFFS,{recursive:true});
        const failedFrame=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        writeFileSync(join(DIFFS,scenario.name+'.failed.png'),Buffer.from(failedFrame.result.data,'base64'));
        throw error;
      }
      if (record) {
        await page.send("Page.stopScreencast");
        if (frames.length < 2) throw new Error("No useful browser recording frames");
        const list = [];
        for (let i = 0; i < frames.length; i++) {
          const file = `frame-${String(i).padStart(4, '0')}.jpg`;
          writeFileSync(join(profile, file), frames[i].data);
          list.push(`file '${file}'`, `duration ${i + 1 < frames.length ? Math.max(0.04, frames[i + 1].timestamp - frames[i].timestamp) : 0.5}`);
        }
        writeFileSync(join(profile, "recording.ffconcat"), "ffconcat version 1.0\n" + list.join("\n") + "\n");
        const video = join(BASELINES, "default-size-scheduling.mp4");
        execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(profile, "recording.ffconcat"), "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video]);
        recordings.push({ file: "default-size-scheduling.mp4", scene: scenario.name, frames: frames.length, source: "CDP screencast; frame timestamp intervals", sha256: createHash("sha256").update(readFileSync(video)).digest("hex") });
      }
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
          mkdirSync(DIFFS, { recursive: true });
          writeFileSync(join(DIFFS, `${scenario.name}.actual.png`), actual);
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
      if (IMPLEMENTATION || UPDATE) artifacts.push({
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
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
  if (IMPLEMENTATION) writeFileSync(join(BASELINES, "manifest.json"), JSON.stringify({
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    branch: execFileSync("git", ["branch", "--show-current"], { cwd: ROOT, encoding: "utf8" }).trim(),
    fixtureRevision: RELEASE_STAGE ? "m5-v1: M1/M2/M3 behavior scenes + empty/load-failure fixtures; 1000 long-title notes/items with deterministic IDs and ten typed filters" : ACCESSIBILITY_STAGE ? "m4-v1: M3 paired fixtures; flat composited contrast/AX audit and empty light search placeholders" : GUIDANCE_STAGE ? "m3-v1: dev-seed; paired locale/theme, supported commands, failed floating capture" : CALENDAR_STAGE ? "m2-v1: dev-seed + twenty similar-prefix todos, due overlay, injected creation failure" : DETAIL_STAGE ? "m1-v1: dev-seed; pending/failing update wrappers" : "w0-v1: dev-seed + 20 similar-prefix calendar entries", clock: CLOCK,
    measurements: RELEASE_STAGE ? releaseMeasurements : undefined,
    sourceFiles: DETAIL_STAGE || CALENDAR_STAGE || GUIDANCE_STAGE || ACCESSIBILITY_STAGE || RELEASE_STAGE ? Object.fromEntries([
      "scripts/visual/release-scenes.mjs",
      "apps/desktop/ui/src/test/ipc-mock.ts", "apps/desktop/ui/src/test/workflow-mock.ts",
      "scripts/visual/accessibility-audit.mjs",
      "apps/desktop/ui/src/features/floating/FloatingBadge.tsx",
      "apps/desktop/ui/src/features/projects/ProjectItemRow.tsx",
      "scripts/visual/guidance-scenes.mjs", "apps/desktop/ui/src/features/search/SearchPanel.tsx", "apps/desktop/ui/src/features/search/CommandPalette.tsx",
      "apps/desktop/ui/src/features/search/SearchApp.tsx", "apps/desktop/ui/src/lib/ipc.ts", "apps/desktop/ui/src/bindings/index.ts",
      "apps/desktop/ui/src/features/quick-create/QuickCreateForm.tsx", "apps/desktop/ui/src/features/quick-create/model/quick-create.ts",
      "apps/desktop/ui/src/features/inbox/InboxRow.tsx", "apps/desktop/ui/src/features/settings/SettingsPage.tsx", "apps/desktop/ui/src/features/settings/SkinSetting.tsx",
      "apps/desktop/ui/src/features/workflows/WorkflowsPage.tsx", "apps/desktop/ui/src/features/workflows/WorkflowEditor.tsx",
      "apps/desktop/ui/src/features/onboarding/OnboardingDialog.tsx", "apps/desktop/ui/src/features/projects/ProjectsPage.tsx", "apps/desktop/ui/src/features/trash/TrashPage.tsx",
      "apps/desktop/ui/src/features/today/TodayPage.tsx", "apps/desktop/ui/src/components/LoadFeedback.tsx", "apps/desktop/ui/src/features/floating/TodayPanel.tsx",
      "apps/desktop/ui/src/app/providers/AppProviders.tsx", "apps/desktop/ui/src/features/inbox/InboxPage.tsx", "apps/desktop/ui/src/features/shell/ShortcutsDialog.tsx",
      "apps/desktop/ui/src/features/calendar/CalendarPage.tsx", "apps/desktop/ui/src/features/calendar/CalendarChip.tsx", "apps/desktop/ui/src/components/Tooltip.tsx",
      "scripts/visual/visual.mjs", "apps/desktop/ui/src/test/dev-seed.ts",
      "apps/desktop/ui/src/features/detail/use-item-draft.ts", "apps/desktop/ui/src/features/detail/ItemDetailPanel.tsx",
      "apps/desktop/ui/src/features/shell/MainShell.tsx", "apps/desktop/ui/src/stores/draft-transition-store.ts",
      "apps/desktop/ui/src/features/shell/nav-store.ts", "apps/desktop/ui/src/features/detail/DraftRecovery.tsx",
      "apps/desktop/ui/src/features/detail/SourceSection.tsx", "apps/desktop/ui/src/features/notes/NoteEditor.tsx",
      "apps/desktop/ui/src/features/notes/NotesPage.tsx", "apps/desktop/ui/src/lib/layout.ts",
      "apps/desktop/ui/src/lib/focus-trap.ts", "apps/desktop/ui/src/components/Menu.tsx",
      "apps/desktop/ui/src/styles/tokens.css", "apps/desktop/ui/src/styles/global.css",
      "apps/desktop/ui/src/i18n/en.json", "apps/desktop/ui/src/i18n/zh-CN.json",
    ].map(file => [file, createHash("sha256").update(readFileSync(join(ROOT, file))).digest("hex")])) : undefined,
    acceptance: RELEASE_STAGE ? "M5 empty/failure recovery and dense browser interaction evidence; timings include CDP/polling and are not native release or participant measurements" : ACCESSIBILITY_STAGE ? "M4 rendered audit: inspect per-scene contrast failures and unmeasured gradients; browser AX trees are not NVDA evidence; native zoom and focus use separate release E2E" : GUIDANCE_STAGE ? "M3: paired language/theme renders, default/narrow layouts, no horizontal overflow or sub-12px guidance, command scope, focus, visible organization/capture routes, retained failed capture; browser mock only" : FOCUS_AUDIT ? "Pre-search-edit focus observations; no native acceptance" : CALENDAR_STAGE ? "M2: twenty entries reachable in week, no horizontal overflow, top-layer backlog without grid compression, persisted scheduling through details and toolbar focus return, failed creation retains input; browser mock only" : DETAIL_STAGE ? "M1: both date controls visible, modal/inert semantics, no page overflow; stable input while saving across 1200px; failed close retains recoverable draft" : "W0 baseline only",
    platform: PLATFORM, timezone: "Asia/Shanghai", motion: "reduce; animations/transitions disabled",
    environment: "Chrome browser mock; OS scale and native WebView2 not certified", artifacts, recordings,
  }, null, 2) + "\n");
  if (UPDATE && !IMPLEMENTATION) writeFileSync(join(BASELINES,"manifest.json"),JSON.stringify({
    sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),
    fixtureRevision:CREATE_STAGE ? 'Create configuration: manual entry, clipboard import, failure and discard on light/dark and narrow viewports' : 'm5 regression: pinned 2026-10-13 clock/IDs, demo backend Today 2026-10-10; actual compact/expanded dimensions',
    platform:PLATFORM,clock:CLOCK,motion:'reduce; screenshot animations disabled',
    sourceFiles:Object.fromEntries(['scripts/visual/visual.mjs','apps/desktop/ui/src/test/dev-seed.ts','apps/desktop/ui/src/styles/tokens.css','apps/desktop/ui/src/styles/global.css',
      ...(CREATE_STAGE ? [
        'scripts/visual/create-configuration-scenes.mjs',
        'apps/desktop/ui/src/features/quick-create/CreateConfiguration.tsx',
        'apps/desktop/ui/src/features/capture/model/drop-draft.ts',
        'apps/desktop/ui/src/i18n/zh-CN.json',
        'apps/desktop/ui/src/i18n/en.json',
      ] : []),
    ].map(file=>[file,createHash('sha256').update(readFileSync(join(ROOT,file))).digest('hex')])),
    artifacts,
  },null,2)+'\n');
  process.exit(failed > 0 || contrastFailures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
