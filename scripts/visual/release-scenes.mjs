/** M5 fixtures. All mutations use the browser's disposable in-memory IPC. */
export function releaseScenes({ app, click, sleep, record }) {
  const wait = async (page, expression, label) => {
    for (let i = 0; i < 150; i++) {
      if (await page.evaluate(expression)) return;
      await sleep(50);
    }
    throw Error(`Release fixture did not settle: ${label}`);
  };
  const prepare = async (page, english, dark) => {
    await wait(page, "!!document.querySelector('main')", 'main bootstrap');
    await page.evaluate(`import('/src/i18n/index.ts').then(m=>m.setLanguage('${english ? 'en' : 'zh-CN'}'))`);
    if (dark) await page.evaluate(`import('/src/stores/theme-store.ts').then(m=>m.useThemeStore.getState().setPreference('dark'))`);
  };
  const navigate = async (page, label, compact, english) => {
    if (compact) await click(page, english ? 'Navigation' : '导航');
    await click(page, label);
  };
  const clear = async page => page.evaluate(`(async()=>{const {ipc}=await import('/src/lib/ipc.ts');const items=await ipc.listItems({itemType:null,includeArchived:true,projectId:null,tagId:null,orderBy:'updated',limit:null});await ipc.deleteItems(items.map(i=>i.id));if(await ipc.getInboxCount()!==0)throw Error('Empty fixture retained a stale Inbox count');})()`);
  const assertLayout = async page => {
    if (await page.evaluate('document.documentElement.scrollWidth>innerWidth')) throw Error('Release scene has page horizontal overflow');
  };
  const seedDense = async (page, kind) => {
    await clear(page);
    await page.evaluate(String.raw`(async()=>{
      const {ipc}=await import('/src/lib/ipc.ts');
      for(let i=0;i<1000;i++){
        const item=await ipc.createItem({itemType:'${kind}',title:'Same prefix / 相同前缀 🌿 entry-'+String(i).padStart(4,'0')+' — '+('Long title 中文标题 '.repeat(7)),content:'Path: C:/Users/Fixture/项目资料/Long folder/document.md\nhttps://example.com/a/very/long/path?fixture='+i,contentFormat:'markdown',priority:i%3===0?'high':null,scheduled:i%3===0?{date:'2026-10-13',time:'15:00:00'}:null,due:i%5===0?{date:'2026-10-01',time:null}:i%3===1?{date:'2026-10-15',time:null}:null,projectId:null,reminderAt:null});
        if('${kind}'==='todo' && i%100===0)await ipc.completeItem(item.id);
        if(i===777)await ipc.setItemTags(item.id,['产品','沟通','design','release','keyboard','source','review','计划']);
      }
      const rows=await ipc.listItems({itemType:'${kind}',includeArchived:false,projectId:null,tagId:null,orderBy:'updated',limit:null});
      if(rows.length!==1000)throw Error('Dense fixture count '+rows.length);
    })()`);
  };
  const typeAndMeasure = async (page, selector, query, result) => {
    await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing fixture input');input.focus();input.select();})()`);
    const start = await page.evaluate('performance.now()');
    await page.send('Input.insertText', { text: query });
    await wait(page, result, 'typed results');
    return await page.evaluate('performance.now()') - start;
  };
  return [
    ...['inbox', 'today'].map((route, index) => ({ name: `release-empty-${route}`, w: 960, h: 640, url: app, steps: async page => {
      await prepare(page, index === 1, index === 1);
      await clear(page);
      await navigate(page, route === 'inbox' ? '收集箱' : 'Today', false, index === 1);
      await wait(page, "document.querySelectorAll('main li').length===0", 'empty list');
      await assertLayout(page);
    } })),
    ...['notes', 'workflows'].map((route, index) => ({ name: `release-error-${route}`, w: index ? 400 : 960, h: index ? 600 : 640, url: app, steps: async page => {
      const english = index === 1;
      await prepare(page, english, english);
      await page.evaluate(`(async()=>{const {ipc}=await import('/src/lib/ipc.ts');const {AppError}=await import('/src/lib/errors.ts');const original=ipc.listItems;${route === 'notes' ? "ipc.listItems=async request=>{if(request.itemType==='note')throw new AppError('STORAGE_UNAVAILABLE','release fixture');return original(request)}" : "ipc.listWorkflows=async()=>{throw new AppError('STORAGE_UNAVAILABLE','release fixture')}"};})()`);
      await navigate(page, english ? 'Automation' : '笔记', english, english);
      // Shared load feedback keeps recovery inline; QueryCache owns the alert.
      await wait(page, `document.querySelector('main')?.innerText.includes('${english ? 'Couldn’t load this view' : '暂时无法加载此页面'}')`, 'persistent load failure');
      await wait(page, `[...document.querySelectorAll('main button')].some(b=>b.textContent.trim()==='${english ? 'Retry' : '重试'}')`, 'retry action');
      if(route==='workflows' && await page.evaluate(`document.querySelector('main').innerText.includes('None yet')`)) throw Error('Failed load incorrectly claims an empty workflow list');
      await assertLayout(page);
    } })),
    { name: 'release-dense-notes-1000', w: 960, h: 640, url: app, steps: async page => {
      await prepare(page, false, false);
      await seedDense(page, 'note');
      await navigate(page, '笔记', false, false);
      await wait(page, "document.querySelectorAll('main li').length===1000", '1000 notes rendered');
      const timings=[];
      for(const suffix of ['0777','0444','0666','0777','0444','0666','0777','0444','0666','0777']) {
        timings.push(await typeAndMeasure(page, 'input[aria-label="筛选笔记"]', 'entry-'+suffix, `document.querySelectorAll('main li').length===1 && document.querySelector('main li').textContent.includes('entry-${suffix}')`));
      }
      record('notes-1000', { count:1000, timings, scope:'Chrome development browser, memory IPC; CDP text insertion to filtered DOM, includes polling, not native release timing' });
      await assertLayout(page);
    } },
    { name: 'release-dense-search-1000', w: 640, h: 220, url: `${app}/?window=search`, steps: async page => {
      await wait(page, "!!document.querySelector('[role=combobox]')", 'search bootstrap');
      await page.evaluate(`import('/src/i18n/index.ts').then(m=>m.setLanguage('en'))`);
      await page.evaluate(`import('/src/stores/theme-store.ts').then(m=>m.useThemeStore.getState().setPreference('dark'))`);
      await seedDense(page, 'todo');
      const timings=[];
      for(const suffix of ['0777','0444','0666','0777','0444','0666','0777','0444','0666','0777']) {
        timings.push(await typeAndMeasure(page, '[role=combobox]', 'entry-'+suffix, `document.querySelectorAll('[role=option]').length===1 && document.querySelector('[role=option]').textContent.includes('entry-${suffix}')`));
      }
      record('search-1000', { count:1000, timings, scope:'Chrome development browser, memory IPC; CDP text insertion through debounce to current result DOM, includes polling, not native release timing' });
      await assertLayout(page);
    } },
  ];
}
