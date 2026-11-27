const SITE_URL = 'https://liulewis67-ops.github.io/StarDeskBox/';
const DOWNLOAD_URL = 'https://github.com/liulewis67-ops/StarDeskBox/releases/download/v0.1.4/StarDeskBox_0.1.4_x64-setup.exe';
const REPO_URL = 'https://github.com/liulewis67-ops/StarDeskBox';
const RELEASES_URL = 'https://github.com/liulewis67-ops/StarDeskBox/releases/tag/v0.1.4';

const copy = {
  zh: {
    title: 'StarDeskBox · Windows 桌面悬浮窗收集与行动工作台 | 待办、笔记与日历',
    description: 'StarDeskBox 是一款为 Windows 打造的开源本地优先桌面收集与行动工作台。通过桌面悬浮窗随手拖放捕获链接、文件、图片与灵感文字，在收件箱整理为待办、笔记与提示，再用今日视图与日历排期推进下一步。',
    keywords: 'StarDeskBox,Windows桌面收集工具,悬浮窗捕获,灵感收集,拖放收件箱,待办事项管理,本地优先笔记,日历排期,个人效率工作台,开源桌面工具,Tauri,SQLite',
    ogLocale: 'zh_CN',
    skip: '跳到正文', nav: '主导航', language: '切换到英语', home: '回到页首',
    theme: { light: '切换到浅色模式', dark: '切换到深色模式' },
    features: '产品能力', workflow: '使用方式', faq: '常见问题',
    cta: '下载 Windows 版', ctaShort: '下载 v0.1.4', repoCta: 'GitHub 开源',
    eyebrow: 'Windows 桌面收集与行动工作台', version: 'v0.1.4',
    hero: ['收下转瞬的灵感，', '安排清晰的下一步。'],
    lead: '把网页链接、本地文件和随手记拖进 Windows 桌面悬浮窗。在收件箱整理为待办、笔记与提示，再用今日与日历安排何时处理。',
    meta: ['Windows x64 安装包', '本机 SQLite 优先存储', 'Apache-2.0 开源'],
    demo: '交互演示', example: '实时可拖放', demoTitle: '把链接拖进悬浮窗',
    windowStatus: '本地已就绪',
    tabs: ['捕获', '整理', '安排'],
    captured: '已收入收件箱', dropIdle: '拖到这里收下', dropReady: '松开即可收下',
    sourceLabel: '浏览器与桌面', replay: '重新演示',
    captureLabel: (label) => `收下「${label}」`, announce: (label) => `「${label}」已收入收件箱`,
    hints: {
      start: '把左下角的卡片拖到悬浮窗里，也可以聚焦后按 Enter 直接收下。',
      next: (label) => `轮到你了：把「${label}」拖进悬浮窗。`,
      done: '都收下了。也可以从电脑上拖一个文件、链接或一段文字到这里试试。',
    },
    input: '设计评审参考', inputType: '链接', file: '周五评审.pdf', fileType: '文件', textType: '文字',
    navDemo: ['收件箱', '今日', '日历'],
    demoHeads: ['收件箱', '今日', '日历'],
    demoLeads: ['给刚收下的信息留个位置', '把今天要跟进的事项放在一起', '为下一步留出时间'],
    rows: ['准备周五的设计评审', '记录首页的修改思路', '跟进评审反馈'],
    types: ['待办', '笔记', '提示'],
    typeKeys: ['task', 'note', 'tip'],
    slot: '周五 · 14:00', scheduled: '设计评审',
    planSlots: [
      { time: '10:00', title: '整理收件箱线索', tag: '今日', focus: false },
      { time: '14:00', title: '设计评审 · 周五评审.pdf', tag: '已排期', focus: true },
      { time: '16:30', title: '跟进首页修改反馈', tag: '待办', focus: false },
    ],
    details: ['', '让待办、笔记与提示各有位置，保留原始来源与上下文。', '把关键评审放进日历时间块，在「今日」聚焦眼前的事。'],
    featureTitle: '让每条信息都有去处。',
    featureSub: '从零散灵感捕获到有节奏的日程推进，每一环都保持轻盈、克制且本地优先。',
    cards: [
      ['悬浮捕获', '一个不打断思路的入口', '从任意窗口随手拖入链接、文件、图片或文字，也支持剪贴板粘贴与全局快捷键记下灵感。'],
      ['来源与规则', '回头找得到原始资料', '完整保留信息来源。常见内容可由捕获工作流自动识别，再转成待办、笔记或提示。'],
      ['今日与日历', '知道今天该先做什么', '用「今日」视图集中处理眼前的事，在日历时间块里给之后的任务留出空间。'],
    ],
    motto: ['拾取散落的信息。', '让事情各归其序。'],
    howTitle: '从收下到行动，只需三步。',
    howSub: '不必在发现信息的当下做决定，先接住，再整理，最后稳步推进。',
    steps: [
      ['随手收下', '看到有用的内容就拖进悬浮窗，继续手头的事。', ['拖放捕获', '剪贴板粘贴', '全局快捷键']],
      ['回头整理', '打开收件箱，决定它是要做的事、留存的笔记，还是一条提示。', ['待办', '笔记', '提示', '保留来源']],
      ['择时行动', '把要做的事排进日历，再从「今日」开始处理。', ['今日聚焦', '日历排期', '本机存储']],
    ],
    faqSub: '关于适用平台、支持收集的内容类型、本地隐私存储与当前版本的常见说明。',
    questions: [
      ['StarDeskBox 是什么？', 'StarDeskBox 是一款开源的 Windows 桌面收集与行动工作台，用同一个悬浮窗入口收集资料、在收件箱整理待办与笔记，并通过今日与日历安排后续行动。'],
      ['StarDeskBox 能收集哪些内容？', '可以收集网页链接、灵感文字、图片、本地文件和文件夹。部分应用来源无法直接拖入时，可复制后在悬浮窗粘贴或使用快捷键捕获。'],
      ['收下的东西会放在哪里？', '新捕获的内容会进入收件箱并保留来源信息，你可以随时把它整理为待办事项、笔记或提示。'],
      ['一定要配置捕获工作流吗？', '不需要。你可以直接手动收集和整理；当需要自动识别和处理常见链接或内容时，再按需启用捕获工作流。'],
      ['我的资料保存在哪里？', 'StarDeskBox 采用本地优先架构，默认将资料保存在本机 SQLite 数据库中。仅在使用需要访问网页或外部服务的捕获工作流时才需要联网。'],
      ['现在可以下载 StarDeskBox 吗？', '当前 v0.1.4 提供免费开源的 Windows x64 安装包，点击下载按钮即可直接下载安装。安装包暂未配置 Windows 代码签名，首次安装时系统可能提示发布者未知。'],
    ],
    endKicker: 'READY FOR WINDOWS · V0.1.4',
    end: '先收下一条线索。',
    endLead: '免费下载开源的 StarDeskBox 0.1.4，把零散的信息变成可安排的下一步行动。',
    foot: '拾取散落的信息，让事情各归其序。',
    footRelease: '发布说明 v0.1.4',
    footLicense: 'Apache-2.0 协议',
    schema: {
      websiteDesc: 'StarDeskBox 是为 Windows 打造的开源本地优先个人收集与行动工作台。',
      altName: 'StarDeskBox 桌面工作台',
      howToName: '如何使用 StarDeskBox 从收集信息到安排行动',
      howToDesc: '从随手拖放收集到收件箱整理，再到日历与今日执行，只需三步。',
      currency: 'CNY',
      features: [
        '桌面悬浮窗拖放捕获链接、文件、图片与文字，支持剪贴板粘贴与全局快捷键',
        '保留原始信息来源，支持捕获工作流自动识别并归类为待办、笔记或提示',
        '今日视图聚焦当下行动，日历时间块合理规划后续任务',
        '数据默认保存在本机 SQLite 数据库，保护隐私且响应迅捷',
        'Apache-2.0 协议开源，基于 Tauri 2、Rust 与 React 构建',
      ],
    },
  },
  en: {
    title: 'StarDeskBox · Local-First Windows Capture & Planning Workspace | Tasks, Notes & Calendar',
    description: 'StarDeskBox is a free, open-source, local-first Windows desktop capture and planning workspace. Drop links, files, images and quick thoughts into a floating window, triage them into tasks, notes or tips, and plan in Today and Calendar.',
    keywords: 'StarDeskBox,Windows desktop capture tool,floating capture window,drag and drop inbox,local-first task manager,SQLite notes app,Today and Calendar planner,open source productivity workspace,Tauri desktop app',
    ogLocale: 'en_US',
    skip: 'Skip to content', nav: 'Main navigation', language: 'Switch to Chinese', home: 'Back to top',
    theme: { light: 'Switch to light mode', dark: 'Switch to dark mode' },
    features: 'Features', workflow: 'How it works', faq: 'FAQ',
    cta: 'Download for Windows', ctaShort: 'Download v0.1.4', repoCta: 'GitHub',
    eyebrow: 'Local-first workspace for Windows', version: 'v0.1.4',
    hero: ['Catch the thought.', 'Find the next step.'],
    lead: 'Drop links, local files and quick thoughts into a Windows floating window. Organize them as tasks, notes or tips, then schedule your next move in Today and Calendar.',
    meta: ['Windows x64 installer', 'Local-first SQLite storage', 'Apache-2.0 open source'],
    demo: 'Interactive demo', example: 'Live drag & drop', demoTitle: 'Drag a link into StarDeskBox',
    windowStatus: 'Local ready',
    tabs: ['Capture', 'Organize', 'Plan'],
    captured: 'Added to your inbox', dropIdle: 'Drop here to capture', dropReady: 'Release to capture',
    sourceLabel: 'Browser & desktop', replay: 'Replay',
    captureLabel: (label) => `Capture “${label}”`, announce: (label) => `“${label}” added to your inbox`,
    hints: {
      start: 'Drag a card from the lower left into the floating window, or focus it and press Enter.',
      next: (label) => `Your turn: drag “${label}” into the floating window.`,
      done: 'All captured. Try dragging a file, link or some text from your computer in here, too.',
    },
    input: 'Design review references', inputType: 'Link', file: 'Friday review.pdf', fileType: 'File', textType: 'Text',
    navDemo: ['Inbox', 'Today', 'Calendar'],
    demoHeads: ['Inbox', 'Today', 'Calendar'],
    demoLeads: ['A place for everything you just captured', 'The things you want to move forward today', 'Make time for your next action'],
    rows: ['Prepare for Friday’s design review', 'Note ideas for the homepage', 'Follow up on review feedback'],
    types: ['Task', 'Note', 'Tip'],
    typeKeys: ['task', 'note', 'tip'],
    slot: 'Friday · 2:00 PM', scheduled: 'Design review',
    planSlots: [
      { time: '10:00', title: 'Triage new inbox captures', tag: 'Today', focus: false },
      { time: '14:00', title: 'Design review · Friday review.pdf', tag: 'Scheduled', focus: true },
      { time: '16:30', title: 'Follow up on homepage notes', tag: 'Task', focus: false },
    ],
    details: ['', 'Give tasks, notes and tips a clear place while preserving original context.', 'Block time on your calendar and focus on what matters next in Today.'],
    featureTitle: 'A place for everything you pick up.',
    featureSub: 'Designed to stay out of your way while you work, keeping your data local-first and ready for action.',
    cards: [
      ['Floating capture', 'Stay with what you’re doing', 'Drop links, files, images or text from any window. Paste from clipboard or use a global shortcut to capture a thought.'],
      ['Sources and rules', 'Find the original when it matters', 'Keep the original source with every item. Capture workflows can recognize familiar inputs and turn them into tasks, notes or tips.'],
      ['Today and Calendar', 'See what to work on first', 'Bring today’s work into focus and reserve dedicated calendar blocks for upcoming tasks.'],
    ],
    motto: ['Pick up what’s scattered.', 'Give it a place.'],
    howTitle: 'Three steps from capture to action.',
    howSub: 'Separate catching an idea from deciding what to do with it.',
    steps: [
      ['Capture it', 'Drop something useful into the floating window and get back to what you were doing.', ['Drag & drop', 'Clipboard paste', 'Global shortcut']],
      ['Sort it later', 'Open your inbox and decide whether it’s a task to do, a note to keep or a tip to remember.', ['Task', 'Note', 'Tip', 'Source kept']],
      ['Make time for it', 'Put the task on your calendar and work through it from Today when it’s time.', ['Today focus', 'Calendar blocks', 'Local-first']],
    ],
    faqSub: 'Quick answers about supported content, local SQLite storage, workflows and the current Windows release.',
    questions: [
      ['What is StarDeskBox?', 'StarDeskBox is an open-source, local-first Windows desktop workspace for collecting information via a floating window, organizing tasks and notes, and planning what comes next.'],
      ['What can I capture?', 'StarDeskBox accepts links, text, images, files and folders. If an item cannot be dragged in directly, copy and paste it into the floating window or use a shortcut.'],
      ['Where do captured items go?', 'Find new items in your inbox with their original source preserved, and organize them as tasks, notes or tips.'],
      ['Do I need to configure a workflow?', 'No. You can capture and organize items manually. Enable capture workflows only when you want to recognize and process familiar content automatically.'],
      ['Where is my data stored?', 'StarDeskBox is local-first and stores your data in a local SQLite database by default. A network connection is only needed for workflows that query webpages or external services.'],
      ['Can I download it now?', 'Version 0.1.4 provides a free, open-source Windows x64 installer directly from the download button. The installer is not yet code-signed, so Windows may display an unknown publisher prompt.'],
    ],
    endKicker: 'READY FOR WINDOWS · V0.1.4',
    end: 'Start with one thing.',
    endLead: 'Download free, open-source StarDeskBox 0.1.4 and turn loose pieces of information into your next action.',
    foot: 'Pick up what’s scattered. Give it a place.',
    footRelease: 'Release v0.1.4',
    footLicense: 'Apache-2.0',
    schema: {
      websiteDesc: 'StarDeskBox is a free, open-source, local-first personal capture and planning workspace for Windows.',
      altName: 'StarDeskBox Desktop Workspace',
      howToName: 'How to turn scattered captures into planned actions with StarDeskBox',
      howToDesc: 'Three simple steps from floating drag-and-drop capture to Today and Calendar execution.',
      currency: 'USD',
      features: [
        'Floating desktop window for drag-and-drop capture of links, files, images and text, plus clipboard paste and shortcuts',
        'Preserves original sources with optional capture workflows to classify items as tasks, notes or tips',
        'Today view for immediate focus paired with Calendar time-blocking',
        'Local-first SQLite storage for speed and privacy by default',
        'Open-source under Apache-2.0, built with Tauri 2, Rust and React',
      ],
    },
  },
};

const featureVisuals = [
  // 01: Floating capture drop motif
  `<svg viewBox="0 0 320 112" aria-hidden="true">
    <defs>
      <linearGradient id="fv1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity=".28"/><stop offset="1" stop-color="#fbbf24" stop-opacity=".18"/></linearGradient>
    </defs>
    <rect x="20" y="18" width="128" height="76" rx="10" fill="none" stroke="currentColor" stroke-opacity=".16"/>
    <path d="M20 34h128" stroke="currentColor" stroke-opacity=".14"/>
    <rect x="34" y="46" width="66" height="8" rx="4" fill="currentColor" fill-opacity=".14"/>
    <rect x="34" y="62" width="94" height="8" rx="4" fill="currentColor" fill-opacity=".09"/>
    <path d="M126 52C162 52 162 56 192 56" fill="none" stroke="#fbbf24" stroke-width="1.6" stroke-dasharray="4 4"/>
    <rect x="150" y="34" width="18" height="18" rx="5" fill="#fbbf24" transform="rotate(14 159 43)"/>
    <rect x="196" y="30" width="104" height="52" rx="14" fill="url(#fv1)" stroke="#60a5fa" stroke-opacity=".55"/>
    <circle cx="212" cy="46" r="3.5" fill="#fbbf24"/>
    <rect x="222" y="42" width="56" height="7" rx="3.5" fill="currentColor" fill-opacity=".28"/>
    <rect x="208" y="58" width="80" height="14" rx="5" fill="#3b82f6" fill-opacity=".22" stroke="#60a5fa" stroke-opacity=".45" stroke-dasharray="3 3"/>
  </svg>`,
  // 02: Sources & workflow rules routing
  `<svg viewBox="0 0 320 112" aria-hidden="true">
    <rect x="24" y="40" width="66" height="32" rx="9" fill="#3b82f6" fill-opacity=".14" stroke="#60a5fa" stroke-opacity=".5"/>
    <rect x="36" y="52" width="42" height="7" rx="3.5" fill="#60a5fa" fill-opacity=".6"/>
    <path d="M90 56h36m24 0h30m0 0 22-26h14m-36 26h36m-36 0 22 26h14" fill="none" stroke="currentColor" stroke-opacity=".26" stroke-width="1.4"/>
    <circle cx="138" cy="56" r="14" fill="#fbbf24" fill-opacity=".16" stroke="#fbbf24" stroke-opacity=".65"/>
    <circle cx="138" cy="56" r="4" fill="#fbbf24"/>
    <rect x="218" y="20" width="76" height="20" rx="10" fill="#3b82f6" fill-opacity=".18" stroke="#60a5fa" stroke-opacity=".5"/>
    <rect x="218" y="46" width="76" height="20" rx="10" fill="#14b8a6" fill-opacity=".16" stroke="#2dd4bf" stroke-opacity=".45"/>
    <rect x="218" y="72" width="76" height="20" rx="10" fill="#fbbf24" fill-opacity=".16" stroke="#fbbf24" stroke-opacity=".5"/>
    <rect x="232" y="27" width="46" height="6" rx="3" fill="#60a5fa" fill-opacity=".75"/>
    <rect x="232" y="53" width="40" height="6" rx="3" fill="#2dd4bf" fill-opacity=".75"/>
    <rect x="232" y="79" width="34" height="6" rx="3" fill="#fbbf24" fill-opacity=".85"/>
  </svg>`,
  // 03: Today & Calendar time blocks
  `<svg viewBox="0 0 320 112" aria-hidden="true">
    <rect x="24" y="18" width="112" height="76" rx="12" fill="none" stroke="currentColor" stroke-opacity=".16"/>
    <circle cx="42" cy="40" r="5" fill="#3b82f6"/>
    <rect x="54" y="36" width="66" height="7" rx="3.5" fill="currentColor" fill-opacity=".35"/>
    <circle cx="42" cy="60" r="5" fill="none" stroke="currentColor" stroke-opacity=".3"/>
    <rect x="54" y="56" width="54" height="7" rx="3.5" fill="currentColor" fill-opacity=".2"/>
    <circle cx="42" cy="78" r="5" fill="none" stroke="currentColor" stroke-opacity=".3"/>
    <rect x="54" y="74" width="60" height="7" rx="3.5" fill="currentColor" fill-opacity=".14"/>
    <rect x="154" y="18" width="142" height="76" rx="12" fill="none" stroke="currentColor" stroke-opacity=".16"/>
    <path d="M168 42h114M168 70h114" stroke="currentColor" stroke-opacity=".1"/>
    <rect x="168" y="28" width="114" height="10" rx="4" fill="currentColor" fill-opacity=".1"/>
    <rect x="168" y="46" width="114" height="22" rx="7" fill="#3b82f6" fill-opacity=".2" stroke="#60a5fa" stroke-opacity=".55"/>
    <rect x="168" y="46" width="4" height="22" rx="2" fill="#fbbf24"/>
    <rect x="180" y="54" width="64" height="6" rx="3" fill="#93c5fd"/>
    <rect x="168" y="74" width="84" height="10" rx="4" fill="currentColor" fill-opacity=".1"/>
  </svg>`,
];

const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#${name}"></use></svg>`;
const icons = ['tray', 'stack', 'calendar'];
const metaIcons = ['window', 'shield', 'spark'];
const site = document.querySelector('#site');
const urlLanguage = () => new URLSearchParams(location.search).get('lang');
const preferred = () => {
  try { return localStorage.getItem('stardeskbox-language'); } catch { return null; }
};
let lang = [urlLanguage(), preferred(), navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'].find((value) => value === 'zh' || value === 'en');
let active = 0;
let revealObserver;
let demoObserver;
// Newest first. Sample cards keep `source` so their labels follow the language; dropped items keep raw text.
let inbox = [];
let drag = null;
let pendingDrag = null;
let suppressClick = false;
let autoplay = null;
let autoplayed = false;
let autoplayTimer = 0;
const root = document.documentElement;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const motionCurve = 'cubic-bezier(.22, 1, .36, 1)';
const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const sourceLabel = (kind) => (kind === 'link' ? copy[lang].input : copy[lang].file);
const itemLabel = (item) => (item.source ? sourceLabel(item.source) : item.label);
const taken = (kind) => inbox.some((item) => item.source === kind);
const cursorArt = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5 3l14 8.2-6.1 1.6L9.6 19z" fill="#fff" stroke="#0b122b" stroke-width="1.5" stroke-linejoin="round"/></svg>';

function hint() {
  const t = copy[lang];
  if (active !== 0) return t.details[active];
  const left = ['link', 'file'].filter((kind) => !taken(kind));
  if (left.length === 2) return t.hints.start;
  return left.length ? t.hints.next(sourceLabel(left[0])) : t.hints.done;
}

function theme() {
  return root.dataset.theme || (systemTheme.matches ? 'dark' : 'light');
}

function updateTheme() {
  const activeTheme = theme();
  const next = activeTheme === 'dark' ? 'light' : 'dark';
  const button = document.querySelector('[data-theme-toggle]');
  if (!button) return;
  button.setAttribute('aria-label', copy[lang].theme[next]);
  button.title = copy[lang].theme[next];
  button.innerHTML = icon(next === 'light' ? 'sun' : 'moon');
  document.querySelector('meta[name="theme-color"]').content = activeTheme === 'dark' ? '#0b0e17' : '#f4f6fb';
}

function syncHeaderScroll() {
  const header = document.querySelector('.header');
  if (header) header.classList.toggle('is-scrolled', window.scrollY > 18);
}

function renderDemo(focusTab = false, motion = '') {
  const t = copy[lang];
  const tabs = document.querySelector('.demo-tabs');
  tabs.innerHTML = t.tabs.map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-selected="${active === index}" aria-controls="demo-panel" tabindex="${active === index ? 0 : -1}" data-tab="${index}">${icon(icons[index])}${label}</button>`).join('');
  const panel = document.querySelector('#demo-panel');
  panel.setAttribute('aria-labelledby', `tab-${active}`);
  panel.classList.toggle('is-capture', active === 0);
  const types = { link: t.inputType, file: t.fileType, text: t.textType };
  const rows = [
    ...(active === 0 ? inbox.map((item) => ({ label: escapeHtml(itemLabel(item)), type: types[item.kind], key: item.kind })) : []),
    ...t.rows.map((label, index) => ({ label, type: t.types[index], key: t.typeKeys[index] })),
  ].slice(0, 3);
  const tray = `<div class="source-tray" role="group" aria-label="${t.sourceLabel}">
      <p class="tray-label" aria-hidden="true">${t.sourceLabel}</p>
      <div class="chips">${taken('link') && taken('file')
        ? `<button type="button" class="source-chip replay" data-replay>${icon('replay')}<span>${t.replay}</span></button>`
        : ['link', 'file'].map((kind) => taken(kind)
          ? `<span class="source-chip taken">${icon('check')}<span>${sourceLabel(kind)}</span></span>`
          : `<button type="button" class="source-chip" data-source="${kind}" aria-label="${t.captureLabel(sourceLabel(kind))}">${icon(kind)}<span>${sourceLabel(kind)}</span></button>`).join('')}</div>
    </div>`;
  const countBadge = active === 2 ? t.slot : `${active === 0 ? inbox.length + 3 : 3}`;
  panel.innerHTML = `
    <div class="window">
      <div class="window-bar">
        <img src="assets/stardeskbox.png" alt="" width="18" height="18">
        <span>StarDeskBox</span>
        <span class="window-status">${t.windowStatus}</span>
        <span class="window-controls" aria-hidden="true">− □ ×</span>
      </div>
      <div class="window-body">
        <div class="rail" aria-hidden="true">${t.navDemo.map((label, index) => `<span class="${index === active ? 'current' : ''}">${icon(icons[index])}<span>${label}</span></span>`).join('')}</div>
        <div class="screen">
          <div class="screen-head">
            <h3>${t.demoHeads[active]}</h3>
            <span class="screen-count">${countBadge}</span>
          </div>
          <p>${t.demoLeads[active]}</p>
          ${active === 2
            ? `<div class="plan-grid">${t.planSlots.map((slot) => `
                <div class="plan-slot">
                  <span class="plan-time">${slot.time}</span>
                  <div class="plan-block${slot.focus ? ' is-focus' : ''}"><strong>${slot.title}</strong><small>${slot.tag}</small></div>
                </div>`).join('')}</div>`
            : rows.map((row, index) =>
              `<div class="item${motion === 'capture' && index === 0 ? ' new-item' : ''}"><span class="item-box" aria-hidden="true"></span><span>${row.label}</span><span class="item-tag tag-${row.key}">${row.type}</span></div>`).join('')}
        </div>
      </div>
    </div>
    <div class="dock">
      ${active === 0 ? tray : ''}
      ${active === 0
        ? `<div class="floating drop-zone${motion === 'capture' ? ' drop-pulse' : ''}" data-drop>
            <div class="float-label"><span></span> StarDeskBox</div>
            <div class="drop-target">${icon(inbox.length ? 'check' : 'tray')}<span data-drop-text>${inbox.length ? t.captured : t.dropIdle}</span></div>
          </div>`
        : `<div class="floating"><div class="float-label"><span></span> StarDeskBox</div><div class="capture-button status">${icon(icons[active])}<span>${active === 2 ? t.slot : t.file}</span></div></div>`}
    </div>`;
  document.querySelector('#demo-description').textContent = hint();
  if (focusTab) document.querySelector(`#tab-${active}`).focus();
  if (motion === 'tab' && !reducedMotion.matches) {
    panel.querySelector('.window').animate(
      [{ opacity: .45, transform: 'translateY(10px) scale(.99)' }, { opacity: 1, transform: 'none' }],
      { duration: 480, easing: motionCurve },
    );
    panel.querySelector('.dock').animate(
      [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 480, easing: motionCurve },
    );
  }
}

function syncSeo(t) {
  const htmlLang = lang === 'zh' ? 'zh-CN' : 'en';
  document.documentElement.lang = htmlLang;
  document.title = t.title;
  const setMeta = (selector, content) => {
    const el = document.querySelector(selector);
    if (el) el.content = content;
  };
  setMeta('meta[name="description"]', t.description);
  setMeta('meta[name="keywords"]', t.keywords);
  setMeta('meta[property="og:title"]', t.title);
  setMeta('meta[property="og:description"]', t.description);
  setMeta('meta[property="og:locale"]', t.ogLocale);
  setMeta('meta[name="twitter:title"]', t.title);
  setMeta('meta[name="twitter:description"]', t.description);
  const ld = document.querySelector('#structured-data');
  if (ld) {
    const pageUrl = urlLanguage() ? `${SITE_URL}?lang=${lang}` : SITE_URL;
    ld.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          '@id': `${SITE_URL}#website`,
          name: 'StarDeskBox',
          url: SITE_URL,
          description: t.schema.websiteDesc,
          inLanguage: ['zh-CN', 'en'],
        },
        {
          '@type': 'WebPage',
          '@id': `${SITE_URL}#webpage`,
          url: pageUrl,
          name: t.title,
          description: t.description,
          isPartOf: { '@id': `${SITE_URL}#website` },
          about: { '@id': `${SITE_URL}#software` },
          inLanguage: htmlLang,
        },
        {
          '@type': 'SoftwareApplication',
          '@id': `${SITE_URL}#software`,
          name: 'StarDeskBox',
          alternateName: t.schema.altName,
          applicationCategory: 'ProductivityApplication',
          operatingSystem: 'Windows 10, Windows 11',
          softwareVersion: '0.1.4',
          description: t.description,
          url: SITE_URL,
          downloadUrl: DOWNLOAD_URL,
          installUrl: DOWNLOAD_URL,
          releaseNotes: RELEASES_URL,
          codeRepository: REPO_URL,
          license: 'https://www.apache.org/licenses/LICENSE-2.0',
          image: `${SITE_URL}assets/stardeskbox.png`,
          isAccessibleForFree: true,
          inLanguage: ['zh-CN', 'en'],
          keywords: t.keywords,
          featureList: t.schema.features,
          offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: t.schema.currency,
            availability: 'https://schema.org/InStock',
          },
          author: {
            '@type': 'Person',
            name: 'liulewis67-ops',
            url: 'https://github.com/liulewis67-ops',
          },
        },
        {
          '@type': 'HowTo',
          '@id': `${SITE_URL}#howto`,
          name: t.schema.howToName,
          description: t.schema.howToDesc,
          inLanguage: htmlLang,
          step: t.steps.map(([name, text], index) => ({
            '@type': 'HowToStep',
            position: index + 1,
            name,
            text,
          })),
        },
        {
          '@type': 'FAQPage',
          '@id': `${SITE_URL}#faq`,
          inLanguage: htmlLang,
          mainEntity: t.questions.map(([name, text]) => ({
            '@type': 'Question',
            name,
            acceptedAnswer: { '@type': 'Answer', text },
          })),
        },
      ],
    });
  }
}

function render(introMotion = false) {
  const t = copy[lang];
  stopAutoplay();
  cancelDrag();
  syncSeo(t);
  const primaryAction = `<a class="button-md primary" href="${DOWNLOAD_URL}">${icon('download')}<span>${t.cta}</span>${icon('arrow')}</a>`;
  const repoAction = `<a class="button-md secondary" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${icon('github')}<span>${t.repoCta}</span></a>`;

  site.innerHTML = `
    <div id="top"></div>
    <a class="skip" href="#main">${t.skip}</a>
    <div class="header-shell">
      <header class="wrap header">
        <a href="#top" class="brand" aria-label="StarDeskBox · ${t.home}">
          <img src="assets/stardeskbox.png" alt="" width="30" height="30">
          <span>StarDeskBox</span>
          <span class="version-pill">${t.version}</span>
        </a>
        <nav aria-label="${t.nav}" class="nav">
          <a href="#features">${t.features}</a>
          <a href="#workflow">${t.workflow}</a>
          <a href="#faq">${t.faq}</a>
        </nav>
        <div class="header-actions">
          <a class="header-cta" href="${DOWNLOAD_URL}">${icon('download')}<span>${t.ctaShort}</span></a>
          <button class="lang theme-toggle" type="button" data-theme-toggle></button>
          <button class="lang" type="button" data-language aria-label="${t.language}">${icon('globe')} <span lang="${lang === 'zh' ? 'en' : 'zh-CN'}">${lang === 'zh' ? 'EN' : '中文'}</span></button>
        </div>
      </header>
    </div>
    <main id="main" tabindex="-1">
      <section class="wrap hero" aria-labelledby="hero-title">
        <div class="intro">
          <p class="caption eyebrow-pill"><span class="signal"></span><span>${t.eyebrow}</span><span class="eyebrow-sep" aria-hidden="true">/</span><span class="eyebrow-ver">${t.version}</span></p>
          <h1 class="heading-1" id="hero-title"><span>${t.hero[0]}</span><span class="hero-accent">${t.hero[1]}</span></h1>
          <p class="lead">${t.lead}</p>
          <div class="cta-row">${primaryAction}${repoAction}</div>
          <div class="hero-meta">${t.meta.map((item, i) => `<span class="hero-meta-item">${icon(metaIcons[i])}<span>${item}</span></span>`).join('')}</div>
        </div>
        <section class="studio" id="demo" aria-labelledby="demo-title">
          <div class="studio-head"><span class="caption"><span class="signal"></span>${t.demo}</span><span class="caption sample">${t.example}</span></div>
          <h2 id="demo-title">${t.demoTitle}</h2>
          <div class="demo-tabs" role="tablist" aria-label="${t.demo}"></div>
          <div id="demo-panel" class="stage" role="tabpanel" tabindex="0" aria-describedby="demo-description"></div>
          <p class="caption demo-description" id="demo-description"></p>
          <div class="sr-only" id="announcement" role="status"></div>
        </section>
      </section>

      <section class="wrap section" id="features" aria-labelledby="features-title">
        <div class="section-head">
          <p class="caption section-kicker"><span>01</span> ${t.features}</p>
          <h2 class="heading-2" id="features-title">${t.featureTitle}</h2>
          <p class="section-sub">${t.featureSub}</p>
        </div>
        <div class="features">${t.cards.map(([label, title, desc], index) => `
          <article class="feature" data-spotlight>
            <div class="feature-top">
              <span class="feature-icon">${icon(icons[index])}</span>
              <span class="caption">${label}</span>
              <span class="feature-num">0${index + 1}</span>
            </div>
            <div class="feature-visual">${featureVisuals[index]}</div>
            <h3>${title}</h3>
            <p>${desc}</p>
          </article>`).join('')}</div>
      </section>

      <section class="motto">
        <div class="wrap motto-content">
          <div class="motto-mark" aria-hidden="true">
            <span class="motto-shard shard-1"></span>
            <span class="motto-shard shard-2"></span>
            <span class="motto-shard shard-3"></span>
            <img src="assets/stardeskbox.png" alt="" width="68" height="68">
          </div>
          <h2 class="heading-2">${t.motto.map((line) => `<span class="motto-line">${(lang === 'zh' ? line.match(/.{1,2}/gu) : line.split(' ')).map((word) => `<span class="word">${word}</span>`).join(lang === 'zh' ? '' : ' ')}</span>`).join(' ')}</h2>
        </div>
      </section>

      <section class="wrap section workflow" id="workflow">
        <div class="workflow-aside">
          <p class="caption section-kicker"><span>02</span> ${t.workflow}</p>
          <h2 class="heading-2">${t.howTitle}</h2>
          <p class="section-sub">${t.howSub}</p>
        </div>
        <ol class="timeline">${t.steps.map(([title, desc, tags], index) => `
          <li>
            <span class="step-index">0${index + 1}</span>
            <div>
              <h3>${title}</h3>
              <p>${desc}</p>
              <div class="step-tags">${tags.map((tag) => `<span class="step-tag">${tag}</span>`).join('')}</div>
            </div>
          </li>`).join('')}</ol>
      </section>

      <section class="wrap section workflow faq" id="faq">
        <div class="workflow-aside">
          <p class="caption section-kicker"><span>03</span> ${t.faq}</p>
          <h2 class="heading-2">${t.faq}</h2>
          <p class="section-sub">${t.faqSub}</p>
        </div>
        <div class="questions">${t.questions.map(([question, answer]) => `
          <details>
            <summary><span>${question}</span><span class="faq-plus" aria-hidden="true">${icon('plus')}</span></summary>
            <p>${answer}</p>
          </details>`).join('')}</div>
      </section>

      <section class="wrap end">
        <div class="end-copy">
          <p class="end-kicker">${t.endKicker}</p>
          <h2 class="heading-2">${t.end}</h2>
          <p>${t.endLead}</p>
        </div>
        <div class="end-actions">${primaryAction}${repoAction}</div>
      </section>
    </main>

    <footer class="wrap footer">
      <a class="brand" href="#top"><img src="assets/stardeskbox.png" alt="" width="24" height="24"><span>StarDeskBox</span></a>
      <p class="caption">${t.foot}</p>
      <div class="footer-links">
        <a href="${RELEASES_URL}" target="_blank" rel="noopener noreferrer">${t.footRelease}</a>
        <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub</a>
        <a href="${REPO_URL}/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">${t.footLicense}</a>
        <a class="to-top" href="#top" aria-label="${t.home}">${icon('up')}</a>
      </div>
    </footer>`;

  renderDemo();
  updateTheme();
  syncHeaderScroll();

  demoObserver?.disconnect();
  if ('IntersectionObserver' in window && !autoplayed && !reducedMotion.matches) {
    demoObserver = new IntersectionObserver(([entry]) => {
      clearTimeout(autoplayTimer);
      if (entry.isIntersecting) autoplayTimer = setTimeout(runAutoplay, introMotion ? 1300 : 700);
    }, { threshold: 0.65 });
    demoObserver.observe(document.querySelector('#demo-panel'));
  }

  if (introMotion && !location.hash && !reducedMotion.matches) site.classList.add('intro-motion');

  revealObserver?.disconnect();
  if ('IntersectionObserver' in window && !reducedMotion.matches) {
    const motto = document.querySelector('.motto-content');
    motto.classList.add('will-reveal');
    motto.querySelectorAll('.word').forEach((word, index) => word.style.setProperty('--delay', `${index * 65}ms`));
    revealObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      }
    }, { threshold: 0.15 });
    revealObserver.observe(motto);
    document.querySelectorAll('.section-kicker, .feature, .timeline li, .end').forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      if (rect.top < innerHeight) return;
      element.style.setProperty('--delay', `${(index % 3) * 65}ms`);
      element.classList.add('scroll-reveal');
      revealObserver.observe(element);
    });
  }
}

function animateCapture(from, row, kind) {
  if (reducedMotion.matches || !row) return;
  const stage = document.querySelector('.stage');
  const origin = stage.getBoundingClientRect();
  const target = row.querySelector('.item-box').getBoundingClientRect();
  const chip = document.createElement('span');
  chip.className = 'capture-flight';
  chip.setAttribute('aria-hidden', 'true');
  chip.innerHTML = icon(kind === 'file' ? 'file' : kind === 'text' ? 'stack' : 'link');
  chip.style.left = `${from.left - origin.left - 4}px`;
  chip.style.top = `${from.top - origin.top - 4}px`;
  stage.append(chip);
  const x = target.left - from.left;
  const y = target.top - from.top;
  const flight = chip.animate([
    { opacity: 1, transform: 'translate(0, 0) scale(1)' },
    { opacity: 1, transform: `translate(${x * .55}px, ${y - 28}px) scale(1.15)`, offset: .55 },
    { opacity: 0, transform: `translate(${x}px, ${y}px) scale(.55)` },
  ], { duration: 560, easing: motionCurve });
  flight.finished.then(() => chip.remove(), () => chip.remove());
}

// ---- Drag-and-drop capture scene ----------------------------------------------------------
const dropZone = () => document.querySelector('[data-drop]');
const easeInOut = (k) => (k < .5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);
const arc = (from, to, k, rise) => {
  const lift = Math.min(from.y, to.y) - rise;
  return { x: from.x + (to.x - from.x) * k, y: (1 - k) ** 2 * from.y + 2 * (1 - k) * k * lift + k ** 2 * to.y };
};

function nearDrop(x, y) {
  const rect = dropZone()?.getBoundingClientRect();
  return Boolean(rect) && x > rect.left - 20 && x < rect.right + 20 && y > rect.top - 20 && y < rect.bottom + 20;
}

function setReady(ready) {
  const zone = dropZone();
  if (!zone) return;
  const t = copy[lang];
  zone.classList.toggle('is-ready', ready);
  zone.querySelector('[data-drop-text]').textContent = ready ? t.dropReady : inbox.length ? t.captured : t.dropIdle;
}

function dropCenter() {
  const rect = dropZone().querySelector('.drop-target').getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function liftChip(chip, x, y, pointer) {
  const rect = chip.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'source-chip drag-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.innerHTML = chip.innerHTML;
  Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
  document.body.append(ghost);
  chip.classList.add('lifted');
  root.classList.add('is-dragging');
  drag = { kind: chip.dataset.source, chip, ghost, rect, dx: x - rect.left, dy: y - rect.top, pointer, ready: false };
  moveDrag(x, y);
}

function ghostTransform(x, y, extra = 'rotate(-3deg) scale(1.06)') {
  return `translate(${x - drag.dx - drag.rect.left}px, ${y - drag.dy - drag.rect.top}px) ${extra}`;
}

function moveDrag(x, y) {
  drag.x = x;
  drag.y = y;
  drag.ghost.style.transform = ghostTransform(x, y);
  const ready = nearDrop(x, y);
  if (ready !== drag.ready) {
    drag.ready = ready;
    setReady(ready);
  }
}

function endDrag(x, y) {
  const current = drag;
  if (!current) return;
  if (!nearDrop(x, y)) return cancelDrag();
  const center = dropCenter();
  const final = ghostTransform(center.x - current.rect.width / 2 + current.dx, center.y - current.rect.height / 2 + current.dy, 'scale(.2)');
  drag = null;
  root.classList.remove('is-dragging');
  const duration = reducedMotion.matches ? 0 : 200;
  current.ghost.animate(
    [{ transform: current.ghost.style.transform, opacity: 1 }, { transform: final, opacity: 0 }],
    { duration, easing: 'cubic-bezier(.5, 0, .75, 0)', fill: 'forwards' },
  );
  setTimeout(() => {
    current.ghost.remove();
    commit([{ source: current.kind, kind: current.kind }]);
  }, duration);
}

function cancelDrag() {
  pendingDrag = null;
  const current = drag;
  if (!current) return;
  drag = null;
  root.classList.remove('is-dragging');
  setReady(false);
  const duration = reducedMotion.matches || !current.chip.isConnected ? 0 : 320;
  current.ghost.animate(
    [{ transform: current.ghost.style.transform }, { transform: 'none' }],
    { duration, easing: motionCurve, fill: 'forwards' },
  );
  setTimeout(() => {
    current.ghost.remove();
    current.chip.classList.remove('lifted');
  }, duration);
}

function flyChip(chip) {
  if (reducedMotion.matches) return commit([{ source: chip.dataset.source, kind: chip.dataset.source }]);
  const rect = chip.getBoundingClientRect();
  liftChip(chip, rect.left + rect.width / 2, rect.top + rect.height / 2, 'key');
  const from = { x: drag.x, y: drag.y };
  const startTime = performance.now();
  const step = (now) => {
    if (drag?.pointer !== 'key') return;
    const k = Math.min(1, (now - startTime) / 520);
    const point = arc(from, dropCenter(), easeInOut(k), 48);
    moveDrag(point.x, point.y);
    if (k < 1) requestAnimationFrame(step);
    else endDrag(point.x, point.y);
  };
  requestAnimationFrame(step);
}

function commit(items) {
  if (!items.length) return;
  const keepFocus = document.activeElement?.closest?.('#demo-panel');
  inbox = [...items.reverse(), ...inbox].slice(0, 6);
  active = 0;
  renderDemo(false, 'capture');
  const from = dropZone().querySelector('.drop-target .icon').getBoundingClientRect();
  animateCapture(from, document.querySelector('.new-item'), inbox[0].kind);
  document.querySelector('#announcement').textContent = copy[lang].announce(itemLabel(inbox[0]));
  if (keepFocus) (document.querySelector('[data-source], [data-replay]') || document.querySelector('#demo-panel')).focus({ preventScroll: true });
}

function readDrop(data) {
  const clip = (text) => (text.length > 48 ? `${text.slice(0, 47)}…` : text);
  const files = [...(data.files || [])].slice(0, 3).map((file) => ({ kind: 'file', label: clip(file.name) }));
  if (files.length) return files;
  const uri = data.getData('text/uri-list').split(/\r?\n/).find((line) => line && !line.startsWith('#'));
  const text = data.getData('text/plain').trim().replace(/\s+/g, ' ');
  const link = uri || (/^https?:\/\/\S+$/.test(text) ? text : '');
  if (link) {
    try {
      const url = new URL(link);
      return [{ kind: 'link', label: clip(url.hostname.replace(/^www\./, '') + (url.pathname === '/' ? '' : url.pathname)) }];
    } catch { return [{ kind: 'link', label: clip(link) }]; }
  }
  return text ? [{ kind: 'text', label: clip(text) }] : [];
}

// ---- Autoplay: a ghost cursor performs the first capture once the demo is in view ----------
function stopAutoplay() {
  clearTimeout(autoplayTimer);
  if (!autoplay) return;
  cancelAnimationFrame(autoplay.frame);
  autoplay.cursor.remove();
  autoplay = null;
  if (drag?.pointer === 'auto') cancelDrag();
}

function runAutoplay() {
  if (autoplay || drag || reducedMotion.matches || active !== 0 || taken('link') || document.hidden) return;
  const chip = document.querySelector('[data-source="link"]');
  if (!chip) return;
  autoplayed = true;
  demoObserver?.disconnect();
  const cursor = document.createElement('div');
  cursor.className = 'ghost-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  cursor.innerHTML = cursorArt;
  document.body.append(cursor);
  const startTime = performance.now();
  let from = null;
  let last = null;
  autoplay = { cursor, frame: 0 };
  const place = (x, y, opacity) => {
    cursor.style.transform = `translate(${x - 5}px, ${y - 3}px)`;
    cursor.style.opacity = opacity;
  };
  const step = (now) => {
    if (!autoplay) return;
    const t = now - startTime;
    if (t < 1150) {
      const rect = chip.getBoundingClientRect();
      const grab = { x: rect.left + Math.min(28, rect.width / 2), y: rect.top + rect.height / 2 };
      const k = easeInOut(Math.min(1, t / 900));
      place(grab.x + 120 * (1 - k), grab.y + 90 * (1 - k), Math.min(1, t / 250));
      cursor.classList.toggle('pressing', t > 950);
      last = grab;
    } else if (t < 2550) {
      if (!drag) liftChip(chip, last.x, last.y, 'auto');
      from ??= { x: drag.x, y: drag.y };
      last = arc(from, dropCenter(), easeInOut((t - 1150) / 1400), 64);
      moveDrag(last.x, last.y);
      place(last.x, last.y, 1);
    } else if (t < 3300) {
      if (drag?.pointer === 'auto') {
        cursor.classList.remove('pressing');
        endDrag(last.x, last.y);
      }
      const k = (t - 2550) / 750;
      place(last.x + 24 * k, last.y + 18 * k, 1 - k);
    } else {
      cursor.remove();
      autoplay = null;
      return;
    }
    autoplay.frame = requestAnimationFrame(step);
  };
  autoplay.frame = requestAnimationFrame(step);
}

// ---- Pointer spotlight on feature cards ----
site.addEventListener('pointermove', (event) => {
  if (pendingDrag?.id === event.pointerId && Math.hypot(event.clientX - pendingDrag.x, event.clientY - pendingDrag.y) > 4) {
    liftChip(pendingDrag.chip, pendingDrag.x, pendingDrag.y, event.pointerId);
    pendingDrag = null;
  }
  if (drag?.pointer === event.pointerId) moveDrag(event.clientX, event.clientY);
  const card = event.target.closest?.('[data-spotlight]');
  if (card && !reducedMotion.matches) {
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    card.style.setProperty('--my', `${event.clientY - rect.top}px`);
  }
});

site.addEventListener('pointerdown', (event) => {
  if (autoplay && event.target.closest('.stage')) stopAutoplay();
  const chip = event.target.closest('[data-source]');
  if (!chip || event.button !== 0 || drag) return;
  pendingDrag = { chip, x: event.clientX, y: event.clientY, id: event.pointerId };
  try { chip.setPointerCapture(event.pointerId); } catch { /* Synthetic or already-released pointer. */ }
});
site.addEventListener('pointerup', (event) => {
  pendingDrag = null;
  if (drag?.pointer !== event.pointerId) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; });
  endDrag(event.clientX, event.clientY);
});
site.addEventListener('pointercancel', (event) => {
  if (drag?.pointer === event.pointerId || pendingDrag?.id === event.pointerId) cancelDrag();
});
site.addEventListener('dragover', (event) => {
  if (!event.target.closest?.('.stage') || drag) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  stopAutoplay();
  if (active !== 0) {
    active = 0;
    renderDemo(false, 'tab');
  }
  if (!dropZone().classList.contains('is-ready')) setReady(true);
});
site.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget?.closest?.('.stage')) setReady(false);
});
site.addEventListener('drop', (event) => {
  if (!event.target.closest?.('.stage')) return;
  event.preventDefault();
  setReady(false);
  commit(readDrop(event.dataTransfer));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drag && drag.pointer !== 'auto') cancelDrag();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoplay();
});

site.addEventListener('click', (event) => {
  if (event.target.closest('[data-theme-toggle]')) {
    root.dataset.theme = theme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('stardeskbox-theme', root.dataset.theme); } catch { /* Keep the choice for this page. */ }
    updateTheme();
    return;
  }
  if (event.target.closest('[data-language]')) {
    lang = lang === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem('stardeskbox-language', lang); } catch { /* URL still records the choice. */ }
    const url = new URL(location.href);
    url.searchParams.set('lang', lang);
    history.replaceState(null, '', url);
    site.classList.remove('intro-motion');
    render();
    document.querySelector('[data-language]').focus({ preventScroll: true });
    return;
  }
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    if (Number(tab.dataset.tab) === active) return;
    stopAutoplay();
    cancelDrag();
    active = Number(tab.dataset.tab);
    renderDemo(true, 'tab');
    return;
  }
  const chip = event.target.closest('[data-source]');
  if (chip && !suppressClick && !drag) {
    stopAutoplay();
    flyChip(chip);
    return;
  }
  if (event.target.closest('[data-replay]')) {
    inbox = [];
    autoplayed = false;
    renderDemo();
    document.querySelector('#demo-panel').focus({ preventScroll: true });
    autoplayTimer = setTimeout(runAutoplay, 350);
  }
});
site.addEventListener('keydown', (event) => {
  if (!event.target.matches('[data-tab]')) return;
  const target = { ArrowLeft: (active + 2) % 3, ArrowRight: (active + 1) % 3, Home: 0, End: 2 }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  stopAutoplay();
  cancelDrag();
  active = target;
  renderDemo(true, 'tab');
});
window.addEventListener('scroll', syncHeaderScroll, { passive: true });
systemTheme.addEventListener('change', updateTheme);
render(true);
if (location.hash) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView());

// Add inertia to wheel input without taking over touch, keyboard or scrollbar scrolling.
let scrollFrame = 0;
let scrollTarget = 0;
let scrollPosition = 0;
let frameTime = 0;
const maxScroll = () => Math.max(0, root.scrollHeight - root.clientHeight);
const clampScroll = (value) => Math.min(maxScroll(), Math.max(0, value));

function stopDamping() {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
}

function dampFrame(now) {
  const target = clampScroll(scrollTarget);
  const elapsed = Math.min(now - frameTime, 48);
  frameTime = now;
  scrollPosition += (target - scrollPosition) * (1 - Math.exp(-elapsed / 85));
  if (Math.abs(target - scrollPosition) <= 0.75) {
    window.scrollTo({ top: target, behavior: 'instant' });
    scrollFrame = 0;
    return;
  }
  window.scrollTo({ top: scrollPosition, behavior: 'instant' });
  scrollFrame = requestAnimationFrame(dampFrame);
}

window.addEventListener('wheel', (event) => {
  if (reducedMotion.matches || !event.cancelable || event.defaultPrevented || event.ctrlKey ||
      event.metaKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  for (let node = event.target; node instanceof Element && node !== document.body; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
  }
  const mode = event.deltaMode;
  const delta = event.deltaY * (mode === 1 ? 16 : mode === 2 ? root.clientHeight : 1);
  const current = window.scrollY;
  if (!scrollFrame) {
    scrollTarget = scrollPosition = current;
    frameTime = performance.now();
  }
  if ((scrollTarget - current) * delta < 0) scrollTarget = scrollPosition = current;
  scrollTarget = clampScroll(current + Math.max(-480, Math.min(480, scrollTarget - current + delta)));
  event.preventDefault();
  if (!scrollFrame) scrollFrame = requestAnimationFrame(dampFrame);
}, { passive: false });

for (const event of ['pointerdown', 'touchstart', 'keydown', 'hashchange', 'resize']) {
  window.addEventListener(event, stopDamping, { passive: true });
}
reducedMotion.addEventListener('change', stopDamping);
