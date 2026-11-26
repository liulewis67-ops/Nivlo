const DOWNLOAD_URL = 'https://github.com/liulewis67-ops/StarDeskBox/releases/download/v0.1.3/StarDeskBox_0.1.3_x64-setup.exe';
const REPO_URL = 'https://github.com/liulewis67-ops/StarDeskBox';
const RELEASES_URL = 'https://github.com/liulewis67-ops/StarDeskBox/releases/tag/v0.1.3';

const copy = {
  zh: {
    title: 'StarDeskBox · 把零散信息变成下一步',
    description: 'StarDeskBox 是 Windows 桌面上的个人收集与行动工作台。随手拖入链接、文字和文件，再用今日与日历安排下一步。',
    skip: '跳到正文', nav: '主导航', language: '切换到英语', home: '回到页首',
    theme: { light: '切换到浅色模式', dark: '切换到深色模式' },
    features: '产品能力', workflow: '使用方式', faq: '常见问题',
    cta: '下载 Windows 版', ctaShort: '下载 v0.1.3', repoCta: 'GitHub 开源',
    eyebrow: 'Windows 桌面工作台', version: 'v0.1.3',
    hero: ['收下转瞬的灵感，', '安排清晰的下一步。'],
    lead: '把链接、文件和随手记拖进桌面悬浮窗。用待办、笔记与提示收好它们，再决定什么时候处理。',
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
    featureSub: '从零散捕获到有节奏的推进，每一环都保持轻盈与克制。',
    cards: [
      ['悬浮捕获', '一个不打断思路的入口', '从当前窗口拖入链接、文件或文字，也可以用粘贴和快捷键记下灵感。'],
      ['来源与规则', '回头找得到原始资料', '保留信息来源。常见内容可由捕获工作流识别，再转成待办、笔记或提示。'],
      ['今日与日历', '知道今天该先做什么', '用「今日」集中处理眼前的事，在日历里给之后的任务留出时间。'],
    ],
    motto: ['拾取散落的信息。', '让事情各归其序。'],
    howTitle: '从收下到行动，只需三步。',
    howSub: '不必在发现信息的当下做决定，先接住，再整理，最后稳步推进。',
    steps: [
      ['随手收下', '看到有用的内容就拖进悬浮窗，继续手头的事。', ['拖放捕获', '剪贴板粘贴', '全局快捷键']],
      ['回头整理', '打开收件箱，决定它是要做的事、留存的笔记，还是一条提示。', ['待办', '笔记', '提示', '保留来源']],
      ['择时行动', '把要做的事排进日历，再从「今日」开始处理。', ['今日聚焦', '日历排期', '本机存储']],
    ],
    faqSub: '关于适用平台、内容类型、隐私存储与当前版本的常见说明。',
    questions: [
      ['StarDeskBox 是什么？', 'StarDeskBox 是一款 Windows 桌面工具，用同一个入口收集资料、整理事项并安排后续行动。'],
      ['能收集哪些内容？', '可以收集链接、文字、图片、文件和文件夹。部分来源无法直接拖入时，可试试复制后在悬浮窗粘贴。'],
      ['收下的东西会放在哪里？', '你可以在收件箱查找新收下的内容，并把它整理为待办、笔记或提示。'],
      ['一定要配置工作流吗？', '不需要。你可以直接收集和手动整理；需要自动识别和处理常见内容时，再使用工作流。'],
      ['资料保存在哪里？', 'StarDeskBox 优先在本机保存资料。某些工作流需要访问网页或外部服务，使用时需要网络。'],
      ['现在可以下载吗？', '0.1.3 提供 Windows x64 安装包，点击下载按钮即可直接下载安装包。安装包未配置 Windows 代码签名，系统可能显示发布者未知。'],
    ],
    endKicker: 'READY FOR WINDOWS · V0.1.3',
    end: '先收下一条线索。',
    endLead: '下载 StarDeskBox 0.1.3，把零散的信息变成可安排的事项。',
    foot: '拾取散落的信息，让事情各归其序。',
    footRelease: '发布说明 v0.1.3',
    footLicense: 'Apache-2.0 协议',
  },
  en: {
    title: 'StarDeskBox · Turn scattered information into your next action',
    description: 'StarDeskBox is a personal capture and planning workspace for Windows. Drop in links, text and files, then plan your next action in Today and Calendar.',
    skip: 'Skip to content', nav: 'Main navigation', language: 'Switch to Chinese', home: 'Back to top',
    theme: { light: 'Switch to light mode', dark: 'Switch to dark mode' },
    features: 'Features', workflow: 'How it works', faq: 'FAQ',
    cta: 'Download for Windows', ctaShort: 'Download v0.1.3', repoCta: 'GitHub',
    eyebrow: 'Desktop workspace for Windows', version: 'v0.1.3',
    hero: ['Catch the thought.', 'Find the next step.'],
    lead: 'Drop links, files and quick thoughts into a floating window. Keep them as tasks, notes or tips, then decide when to act.',
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
    featureSub: 'Designed to stay out of your way while you work, and bring clarity when you plan.',
    cards: [
      ['Floating capture', 'Stay with what you’re doing', 'Drop links, files or text from the window you’re in. Paste or use a shortcut to capture a thought.'],
      ['Sources and rules', 'Find the original when it matters', 'Keep the source with the item. Capture workflows can recognize familiar inputs and turn them into tasks, notes or tips.'],
      ['Today and Calendar', 'See what to work on first', 'Bring today’s work into focus and give later tasks a spot on your calendar.'],
    ],
    motto: ['Pick up what’s scattered.', 'Give it a place.'],
    howTitle: 'Three steps from capture to action.',
    howSub: 'Separate catching an idea from deciding what to do with it.',
    steps: [
      ['Capture it', 'Drop something useful into the floating window and get back to what you were doing.', ['Drag & drop', 'Clipboard paste', 'Global shortcut']],
      ['Sort it later', 'Open your inbox and decide whether it’s a task to do, a note to keep or a tip to remember.', ['Task', 'Note', 'Tip', 'Source kept']],
      ['Make time for it', 'Put the task on your calendar and work through it from Today when it’s time.', ['Today focus', 'Calendar blocks', 'Local-first']],
    ],
    faqSub: 'Quick answers about supported content, local storage, workflows and the current release.',
    questions: [
      ['What is StarDeskBox?', 'StarDeskBox is a Windows desktop tool for collecting information, organizing it and planning what comes next.'],
      ['What can I capture?', 'StarDeskBox accepts links, text, images, files and folders. If an item cannot be dragged in directly, try copying it and pasting it into the floating window.'],
      ['Where do captured items go?', 'Find new items in your inbox and organize them as tasks, notes or tips.'],
      ['Do I need to configure a workflow?', 'No. You can capture and organize items manually. Use workflows when you want to recognize and process familiar content automatically.'],
      ['Where is my data stored?', 'StarDeskBox keeps your data on your computer by default. Workflows that look up webpages or use external services need a network connection.'],
      ['Can I download it now?', 'Version 0.1.3 provides a Windows x64 installer that downloads directly from the download button. The installer has no Windows code-signing certificate, so Windows may show an unknown publisher.'],
    ],
    endKicker: 'READY FOR WINDOWS · V0.1.3',
    end: 'Start with one thing.',
    endLead: 'Download StarDeskBox 0.1.3 and turn loose pieces of information into your next action.',
    foot: 'Pick up what’s scattered. Give it a place.',
    footRelease: 'Release v0.1.3',
    footLicense: 'Apache-2.0',
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

function render(introMotion = false) {
  const t = copy[lang];
  stopAutoplay();
  cancelDrag();
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t.title;
  document.querySelector('meta[name="description"]').content = t.description;
  for (const [property, content] of [['og:title', t.title], ['og:description', t.description]]) {
    document.querySelector(`meta[property="${property}"]`).content = content;
  }
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
