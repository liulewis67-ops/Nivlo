/** 完整新增配置的浏览器验收；原生位置另由控制器测试与实机验收负责。 */
export function createConfigurationScenes({ app, sleep }) {
  return [
    { name: "create-desktop-light-zh", w: 640, h: 720 },
    { name: "create-compact-drop-light-zh", w: 640, h: 720, compactDrop: true },
    { name: "create-desktop-dark-en", w: 640, h: 720, en: true, dark: true },
    { name: "create-narrow-light-zh", w: 400, h: 560, bottom: true },
    { name: "create-failed-dark-en", w: 400, h: 560, en: true, dark: true, fail: true },
    { name: "create-discard-light-zh", w: 640, h: 720, discard: true },
    { name: "create-import-light-zh", w: 640, h: 720, imported: true },
    { name: "create-import-narrow-dark-en", w: 400, h: 560, en: true, dark: true, imported: true },
  ].map(scene => ({ ...scene, url: `${app}/?window=floating`, steps: async page => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await page.evaluate("!!document.querySelector('button')")) break;
      await sleep(200);
    }
    if (scene.en) await page.evaluate("import('/src/i18n/index.ts').then(m => m.setLanguage('en'))");
    if (scene.dark) await page.evaluate("import('/src/stores/theme-store.ts').then(m => m.useThemeStore.getState().setPreference('dark'))");
    if (scene.compactDrop) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 64, height: 32, deviceScaleFactor: 1, mobile: false });
      await page.evaluate(`(() => {
        const data = new DataTransfer();
        data.setData('text/plain', 'img_v3_0217l_98167668-d756-4016-b761-fd4182151b7g.jpg\\nhttps://example.com/98167668-d756-4016-b761-fd4182151b7g.jpg');
        document.querySelector('button').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      })()`);
    } else await page.evaluate("document.querySelector('button').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2}))");
    await sleep(200);
    if (scene.compactDrop) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: scene.w, height: scene.h, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      const openingScroll = await page.evaluate(`(() => {
        const fields = document.querySelector('[role=dialog] fieldset');
        return { x: fields.scrollLeft, y: fields.scrollTop, pageX: scrollX, pageY: scrollY };
      })()`);
      if (Object.values(openingScroll).some(value => value !== 0)) throw Error('Opening focus displaced the form: ' + JSON.stringify(openingScroll));
    }
    const message = scene.en
      ? "Send the updated quote\nThe customer asked for the new totals.\nReference: https://example.com/quote"
      : "发给客户新版报价\n客户需要更新后的合计。\n参考资料：https://example.com/quote";
    if (scene.imported) {
      await page.evaluate(`(async () => {
        const { ipc } = await import('/src/lib/ipc.ts');
        ipc.readClipboardText = async () => ${JSON.stringify(message)};
        const label = ${JSON.stringify(scene.en ? "Import from clipboard" : "从剪贴板导入")};
        [...document.querySelectorAll('button')].find(button => button.textContent.trim() === label).click();
      })()`);
    } else await page.evaluate(`(() => {
      const input = document.querySelector('input');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, ${JSON.stringify(scene.en ? "Prepare the design review" : "准备产品设计评审")});
      input.dispatchEvent(new Event('input', {bubbles:true}));
      const content = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(content, ${JSON.stringify(scene.en ? "Review the capture flow, confirm the schedule, and collect feedback." : "梳理收集流程，确认时间安排，并整理评审意见。")});
      content.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await sleep(150);
    if (scene.fail) {
      await page.evaluate(`(async () => {
        const { ipc } = await import('/src/lib/ipc.ts');
        const { AppError } = await import('/src/lib/errors.ts');
        ipc.createItem = async () => { throw new AppError('STORAGE_UNAVAILABLE', 'test busy'); };
        document.querySelector('button[type=submit]').click();
      })()`);
    }
    if (scene.discard) await page.evaluate("[...document.querySelectorAll('footer button')].find(b => b.textContent === '取消').click()");
    if (scene.bottom) await page.evaluate("document.querySelector('fieldset').scrollTop = 10000");
    await sleep(250);
    const result = await page.evaluate(`(() => {
      const form = document.querySelector('[role=dialog]');
      const footer = form.querySelector('footer').getBoundingClientRect();
      const fields = form.querySelector('fieldset');
      return {
        dialog: !!form,
        aligned: form.getBoundingClientRect().left === 0 && form.getBoundingClientRect().top === 0,
        overflow: document.documentElement.scrollWidth > innerWidth || fields.scrollWidth > fields.clientWidth,
        footerVisible: footer.top >= 0 && footer.bottom <= innerHeight,
        draftRetained: form.querySelector('textarea').value.length > 0,
        importPreserved: ${scene.imported ? `form.querySelector('textarea').value === ${JSON.stringify(message)}
          && form.querySelector('input[required]').value === ${JSON.stringify(message.split("\n")[0])}
          && [...form.querySelectorAll('button[aria-pressed="true"]')].some(
            button => button.textContent.trim() === ${JSON.stringify(scene.en ? "Inbox" : "收集箱")}
          )
          && form.textContent.includes(${JSON.stringify(scene.en ? "From the clipboard" : "来自剪贴板")})` : "true"},
        errorVisible: ${scene.fail ? "!!form.querySelector('[role=alert]')" : "true"},
        discardProtected: ${scene.discard ? "form.querySelector('fieldset').disabled && !form.querySelector('button[type=submit]')" : "true"}
      };
    })()`);
    if (!result.dialog || !result.aligned || result.overflow || !result.footerVisible || !result.draftRetained || !result.importPreserved || !result.errorVisible || !result.discardProtected) throw Error(JSON.stringify(result));
  } }));
}
