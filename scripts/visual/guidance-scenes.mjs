/** M3 browser fixtures; uses the same isolated IPC/profile and pinned clock as other stages. */
export function guidanceScenes({ app, click, sleep }) {
  const definitions = [];
  for (const route of ['Inbox', 'Settings', 'Workflows', 'Notes', 'Projects', 'Today', 'Trash', 'Onboarding']) {
    definitions.push({ name: `guidance-${route.toLowerCase()}-960-zh`, route, w: 960, h: 640 });
    definitions.push({ name: `guidance-${route.toLowerCase()}-400-en-dark`, route, w: 400, h: 600, en: true, dark: true });
  }
  for (const route of ['Palette', 'Global', 'Capture']) {
    definitions.push({ name: `guidance-${route.toLowerCase()}-zh`, route, w: route === 'Palette' ? 960 : route === 'Global' ? 640 : 300, h: route === 'Palette' ? 640 : route === 'Global' ? 440 : 380 });
    definitions.push({ name: `guidance-${route.toLowerCase()}-en-dark`, route, w: route === 'Palette' ? 960 : route === 'Global' ? 640 : 300, h: route === 'Palette' ? 640 : route === 'Global' ? 440 : 380, en: true, dark: true });
  }
  definitions.push({ name: 'guidance-global-error-undo-zh', route: 'Global', w: 640, h: 440, error: true });
  return definitions.map(scene => ({ ...scene, url: scene.route === 'Global' ? `${app}/?window=search` : scene.route === 'Capture' ? `${app}/?window=floating` : app, steps: async page => {
    await page.send('Page.bringToFront');
    await page.evaluate(`import('/src/i18n/index.ts').then(m => m.setLanguage('${scene.en ? 'en' : 'zh-CN'}'))`);
    if (scene.dark) await page.evaluate("import('/src/stores/theme-store.ts').then(m => m.useThemeStore.getState().setPreference('dark'))");
    const label = (en, zh) => scene.en ? en : zh;
    if (scene.route === 'Capture') {
      const [x,y] = await page.evaluate(`(() => {const r=document.querySelector('button').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
      await page.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:x+100,y:y+100});
      await page.send('Input.dispatchMouseEvent', {type:'mouseMoved',x,y});
      await sleep(900);
      await click(page, label('+ To-do', '+ 待办'));
      await sleep(200);
      await page.send('Input.insertText',{text:'Capture draft / 保留草稿'});
      await page.evaluate(`document.querySelector('[data-kind=note]').click()`);
      if (!await page.evaluate(`document.activeElement === document.querySelector('input') && document.querySelector('[data-kind=note]').getAttribute('aria-checked') === 'true'`)) throw Error('Type selection lost capture focus');
      if (scene.en) {
        await page.evaluate(`(async()=>{ const {ipc}=await import('/src/lib/ipc.ts'); const {AppError}=await import('/src/lib/errors.ts'); ipc.quickCreate=async()=>{throw new AppError('STORAGE_UNAVAILABLE','injected')};})()`);
        await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
        await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        await sleep(200);
        if (!await page.evaluate(`document.querySelector('input').value === 'Capture draft / 保留草稿'`)) throw Error('Capture failure lost text');
      }
    } else if (scene.route === 'Global' || scene.route === 'Palette') {
      if (scene.route === 'Palette') await click(page, label('Search', '搜索'));
      await sleep(200);
      if (!await page.evaluate(`document.activeElement === document.querySelector('[role=combobox]')`)) throw Error('Search did not focus');
      if (scene.error) {
        await page.send('Input.insertText', {text:'邮件'});
        await sleep(350);
        for (let attempt = 0; !await page.evaluate(`(() => { const b=[...document.querySelectorAll('footer button')].find(b=>b.textContent.startsWith('完成')); if (!b) return false; b.click(); return true; })()`); attempt++) {
          if (attempt > 30) throw Error('Missing complete action');
          await sleep(100);
        }
        await sleep(150);
        await page.evaluate(`(async()=>{ const {ipc}=await import('/src/lib/ipc.ts'); const {AppError}=await import('/src/lib/errors.ts'); ipc.reopenItem=async()=>{throw new AppError('STORAGE_UNAVAILABLE','injected')}; })()`);
        await click(page,'撤销 Ctrl+Z');
        await sleep(150);
        if (!await page.evaluate(`(() => { const alert = document.querySelector('[role=alert]'); const undo = [...document.querySelectorAll('footer button')].find(b=>b.textContent.includes('撤销')); return alert && undo && alert.getBoundingClientRect().bottom <= document.querySelector('footer').getBoundingClientRect().top && undo.getBoundingClientRect().bottom <= innerHeight; })()`)) throw Error('Search error obscured Undo');
      } else {
        if (scene.en) await click(page, 'Keyboard help');
        else await click(page, '命令');
        if (!await page.evaluate(`document.activeElement === document.querySelector('[role=combobox]') || document.activeElement.textContent === 'Keyboard help'`)) throw Error('Mode/help lost sensible focus');
      }
      if (scene.route === 'Palette' && !scene.en && !await page.evaluate(`document.querySelector('[role=listbox]')?.textContent.includes('新建笔记')`)) throw Error('Main commands lost supported actions');
      if (scene.route === 'Global' && !scene.en && !scene.error && await page.evaluate(`document.querySelector('[role=listbox]')?.textContent.includes('新建笔记')`)) throw Error('Global search promised unsupported commands');
    } else {
      const names={Inbox:'收集箱',Settings:'设置',Workflows:'自动化',Notes:'笔记',Projects:'项目',Today:'今天',Trash:'回收站',Onboarding:'设置'};
      if (scene.w<800) await click(page,label('Navigation','导航'));
      await click(page,scene.route==='Onboarding'?label('Settings','设置'):label(scene.route === 'Workflows' ? 'Automation' : scene.route,names[scene.route]));
      await sleep(350);
      if (scene.route==='Settings' && scene.en) {
        await click(page,'Appearance');
        await sleep(100);
        if (!await page.evaluate(`document.activeElement.tagName === 'H2' && document.querySelector('nav[aria-label] button[aria-current=location]')?.textContent === 'Appearance'`)) throw Error('Settings section did not focus/mark current location');
      }
      if (scene.route==='Workflows') {
        if (scene.en) await page.evaluate(`document.querySelector('[data-workflow-item]').click()`);
        if (!scene.en && !await page.evaluate(`document.querySelector('[data-workflow-item]').getBoundingClientRect().width > 400`)) throw Error('Workflow list still wastes empty workspace');
      }
      if (scene.route==='Projects') await page.evaluate(`document.querySelector('[data-sidebar-item]').click()`);
      if (scene.route==='Onboarding') {
        await page.evaluate(`(() => { const b = document.querySelector('#settings-onboarding button'); b.scrollIntoView({block:'center'}); b.click(); })()`);
        await sleep(200);
        await page.evaluate(`document.querySelector('[role=tab][aria-label*="3"]').click()`);
      }
      if (scene.route==='Inbox' && !await page.evaluate(`!!document.querySelector('main li button[aria-label]')`)) throw Error('Inbox lacks visible organize route');
    }
    await sleep(350);
    const checks=await page.evaluate(`(() => {
      const small=[...document.querySelectorAll('main button,footer,dialog p,[role=dialog] p')].filter(e=>e.getClientRects().length && parseFloat(getComputedStyle(e).fontSize)<12).map(e=>e.textContent.slice(0,80));
      return {noOverflow:document.documentElement.scrollWidth<=innerWidth,small};
    })()`);
    if (!checks.noOverflow || checks.small.length) throw Error(`${scene.name}: ${JSON.stringify(checks)}`);
  } }));
}
