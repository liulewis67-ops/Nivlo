/** 关联文件只读预览的浏览器验收；磁盘读取由 Rust 测试覆盖。 */
export function attachmentScenes({ app, sleep }) {
  return [
    { name: "attachment-detail-text-680-zh", w: 680, h: 720 },
    { name: "attachment-detail-image-400-en", w: 400, h: 640, image: true, dark: true },
    { name: "attachment-main-text-1100-zh", w: 1100, h: 720, main: true },
  ].map(scene => ({ ...scene, url: scene.main ? app : `${app}/?window=detail`, steps: async page => {
    for (let i = 0; !await page.evaluate("!!document.querySelector('main')"); i++) {
      if (i > 50) throw Error('Shell did not become ready');
      await sleep(100);
    }
    await page.evaluate(`(async () => {
      const { ipc } = await import('/src/lib/ipc.ts');

      if (${!!scene.dark}) {
        await import('/src/i18n/index.ts').then(m => m.setLanguage('en'));
        await import('/src/stores/theme-store.ts').then(m => m.useThemeStore.getState().setPreference('dark'));
      }
      const item = ${scene.main ? "await ipc.quickCreate('todo', 'Linked reference files')" : "(await ipc.getItemDetail(new URLSearchParams(location.search).get('item'))).item"};
      const original = ipc.getItemDetail;
      ipc.getItemDetail = async id => ({ ...await original(id), attachments: [
        { kind:'reference', path:'C:/references/meeting-notes.txt', name:'meeting-notes.txt', mime:'text/plain', sizeBytes:100, exists:true },
        { kind:'stored', path:'screenshot.png', name:'screenshot.png', mime:'image/png', sizeBytes:100, exists:true }
      ] });
      const canvas = document.createElement('canvas');
      canvas.width = 600; canvas.height = 320;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#e8eef8'; ctx.fillRect(0, 0, 600, 320);
      ctx.fillStyle = '#2563eb'; ctx.fillRect(36, 40, 528, 64);
      ctx.fillStyle = '#1b1f27'; ctx.font = '24px sans-serif';
      ctx.fillText('Screenshot reference', 36, 168);
      ipc.previewItemAttachment = async (_, index) => index === 0
        ? { kind:'text', content:'Meeting notes / 会议记录\\n\\nCustomer requested an updated quote.\\n<example>Content is shown as plain text.</example>\\n' + 'Long reference line '.repeat(30) }
        : { kind:'image', url: canvas.toDataURL('image/png') };
      await ipc.updateItem(item.id, { title: 'Linked reference files' });
      ${scene.main ? "const { useNavStore } = await import('/src/features/shell/nav-store.ts'); useNavStore.getState().openItem(item.id);" : ""}
    })()`);
    const name = scene.image ? 'screenshot.png' : 'meeting-notes.txt';
    for (let i = 0; !await page.evaluate(`!!document.querySelector('button[aria-label*="${name}"]')`); i++) {
      if (i > 30) throw Error('Attachment action missing');
      await sleep(100);
    }
    await page.evaluate(`document.querySelector('button[aria-label*="${name}"]').click()`);
    await sleep(400);
    const result = await page.evaluate(`(() => {
      const section = document.querySelector('section[aria-label*="${scene.image ? 'Preview' : '预览'}"]');
      section.scrollIntoView({block:'center'});
      const img = section.querySelector('img');
      return { exists:!!section, readOnly:!section.querySelector('input,textarea,[contenteditable=true]'),
        rendered:${scene.image ? 'img.complete && img.naturalWidth > 0' : "section.querySelector('pre').textContent.includes('<example>')"},
        fits:section.scrollWidth <= section.clientWidth && document.documentElement.scrollWidth <= innerWidth };
    })()`);
    if (!result.exists || !result.readOnly || !result.rendered || !result.fits) throw Error(JSON.stringify(result));
  } }));
}
