const pw = require('/home/gaurav/AI-Editor/node_modules/playwright-core');
(async () => {
  const b = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const pg = await (await b.newContext()).newPage();
  await pg.setViewportSize({ width: 1280, height: 900 });
  const errs = [];
  pg.on('pageerror', e => errs.push('pageerror: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await pg.goto('http://127.0.0.1:8481/', { waitUntil: 'networkidle' });

  const rows = () => pg.$$('#optRows .opt-row');
  // raw pointer click: elementHandle.click has a scroll/hit-test quirk in this
  // Chrome build — a real mouse event at the button center works reliably.
  const clickGear = async (i) => {
    const rs = await rows();
    const bb = await rs[i].boundingBox();
    await rs[i].evaluate(r => r.querySelector('.gear').getBoundingClientRect());
    const gb = await rs[i].evaluate(r => {
      const g = r.querySelector('.gear').getBoundingClientRect();
      window.scrollTo(0, Math.max(0, g.top - 300)); // put it comfortably in view
      return { cx: g.x + g.width / 2, cy: g.y + g.height / 2 };
    });
    await pg.waitForTimeout(250);
    const gb2 = await rs[i].evaluate(r => {
      const g = r.querySelector('.gear').getBoundingClientRect();
      return { cx: g.x + g.width / 2, cy: g.y + g.height / 2 };
    });
    await pg.mouse.click(gb2.cx, gb2.cy);
    await pg.waitForFunction(() => !document.getElementById('modalBack').classList.contains('hidden'), { timeout: 4000 });
  };

  // 1. brand gallery
  await clickGear(0);
  await pg.waitForSelector('.tpl-card', { timeout: 8000 });
  console.log('cards:', await pg.locator('.tpl-card').count());
  const vids = await pg.$$eval('.tpl-card video', vs => vs.map(v => v.networkState));
  console.log('videos:', vids.length, 'all ok:', vids.every(n => n <= 2));
  // hover plays, leave pauses
  const cardBox = await pg.locator('.tpl-card').nth(1).boundingBox();
  await pg.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 10);
  await pg.waitForTimeout(500);
  const playing = await pg.locator('.tpl-card').nth(1).evaluate(v => v.querySelector('video').paused === false);
  await pg.mouse.move(10, 10);
  await pg.waitForTimeout(300);
  const pausedNow = await pg.$$eval('.tpl-card video', vs => vs.every(v => v.paused));
  console.log('hover plays:', playing, '| paused after leave:', pausedNow);

  // 2. select fastcuts
  await pg.click('.tpl-card:has(.tpl-name:text("MrBeast fast-cut energy"))');
  await pg.waitForSelector('.tpl-card.sel');
  const st1 = await pg.evaluate(() => {
    const s = window.__11se.state;
    return { brand: s.settings.brand.template, name: s.settings.brand.name,
      hasStructure: !!s.settings.brand.structure, hasStyle: !!s.settings.brand.style,
      cap: s.settings.captions, hookColor: s.settings.textHook.color,
      zoom: s.settings.zooms, music: s.settings.music,
      tgl: { music: s.toggles.music, sfx: s.toggles.sfx, broll: s.toggles.broll } };
  });
  console.log('after fastcuts:', JSON.stringify(st1));

  // 3. captions gear reflects inherited values
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(2600);
  await clickGear(4);
  await pg.waitForTimeout(200);
  const cap = await pg.evaluate(() => {
    const m = document.getElementById('modal');
    return { title: m.querySelector('h3').textContent,
      size: m.querySelector('input[type=number]') && m.querySelector('input[type=number]').value,
      inherit: !!m.querySelector('.m-inherit') };
  });
  console.log('captions gear:', JSON.stringify(cap));

  // 4. inherit link on textHook row applies the template's hook color
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(2600);
  await clickGear(15); // textHook row
  await pg.waitForTimeout(200);
  const inh = await pg.$('.m-inherit');
  if (inh) await inh.click();
  await pg.waitForTimeout(250);
  const swSel = await pg.evaluate(() => ({
    stateColor: window.__11se.state.settings.textHook.color,
    swatchSel: (() => { const s = document.querySelector('#modal .color-sw.sel'); return s ? s.style.background : null; })(),
    swatchCount: document.querySelectorAll('#modal .color-sw').length,
  }));
  console.log('textHook inherit (expect state #ffd60a + 7 swatches, one selected):', JSON.stringify(swSel));
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(2600);

  // 5. switch to storytime
  await clickGear(0);
  await pg.waitForSelector('.tpl-card');
  await pg.click('.tpl-card:has(.tpl-name:text("Storytime"))');
  await pg.waitForSelector('.tpl-card.sel');
  const st2 = await pg.evaluate(() => ({
    brand: window.__11se.state.settings.brand.template,
    capSize: window.__11se.state.settings.captions.size,
    sfx: window.__11se.state.toggles.sfx,
    broll: window.__11se.state.toggles.broll,
    hookColor: window.__11se.state.settings.textHook.color,
    zoom: window.__11se.state.settings.zooms,
  }));
  console.log('storytime applied:', JSON.stringify(st2));

  // 6. "none" resets
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(2600);
  await clickGear(0);
  await pg.waitForSelector('.tpl-card');
  await pg.click('.tpl-card:has(.tpl-name:text("None"))');
  await pg.waitForTimeout(200);
  const st3 = await pg.evaluate(() => window.__11se.state.settings.brand.template);
  console.log('none selected ->', st3);

  // 7. job payload shape
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(300);
  const brandPayload = await pg.evaluate(() => {
    const s = window.__11se.state;
    return s.settings.brand; // same object that goes in the POST body
  });
  console.log('brand payload keys:', Object.keys(brandPayload));

  // 8. close → all videos paused, no lingering audio
  const pausedAll = await pg.$$eval('.tpl-card video', vs => vs.every(v => v.paused));
  console.log('all paused after close:', pausedAll);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
