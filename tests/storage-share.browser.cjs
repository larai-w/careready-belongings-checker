// Run with an existing Playwright module path as argv[2]; no dependency installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const engine = process.env.CAREREADY_TEST_BROWSER || 'chromium';
if (!['chromium', 'webkit'].includes(engine)) throw new Error('Unsupported test browser');
const browserType = require(process.argv[2] || 'playwright')[engine];
const tlsDir = process.env.CAREREADY_TEST_TLS_DIR;
const transport = tlsDir ? require('node:https') : http;
const serverOptions = tlsDir ? {key:fs.readFileSync(path.join(tlsDir,'key.pem')),cert:fs.readFileSync(path.join(tlsDir,'cert.pem'))} : {};
const scheme = tlsDir ? 'https' : 'http';
const root = path.resolve(__dirname, '..');
const files = new Set(['index.html', 'app.js', 'storage.js', 'data.json', 'manifest.webmanifest',
  'lib/backup.js', 'lib/backup-ui.js', 'lib/share.js', 'lib/checklist.js', 'lib/ocr-match.js', 'lib/care-event.js']);
const server = transport.createServer(serverOptions, (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1);
  if (name === 'harness') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Storage test</title>'); return; }
  if (!files.has(name)) { response.writeHead(204); response.end(); return; }
  response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.json') ? 'application/json' : 'text/html');
  response.end(fs.readFileSync(path.join(root, name)));
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = scheme + '://127.0.0.1:' + server.address().port;
    browser = await browserType.launch({ headless: true });
    // A failed migration must leave the old copy available for the next startup.
    for (const failure of ['throw', 'abort', 'none']) {
      const context = await browser.newContext({ ignoreHTTPSErrors: Boolean(tlsDir), serviceWorkers: 'block' });
      const page = await context.newPage(); await page.goto(base + '/harness');
      const result = await page.evaluate(async failure => {
        const oldKey = 'careready_checked_items';
        const backup = JSON.stringify({ 'sample-item': true });
        localStorage.setItem(oldKey, backup);
        let sourcePresentDuringWrite = false;
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          sourcePresentDuringWrite = localStorage.getItem(oldKey) === backup;
          if (failure === 'throw') throw new DOMException('quota', 'QuotaExceededError');
          const request = original.apply(this, args);
          if (failure === 'abort') request.addEventListener('success', () => this.transaction.abort());
          return request;
        };
        const storage = await import('/storage.js');
        await Promise.race([storage.initStorage(), new Promise((_, reject) => setTimeout(() => reject(new Error('migration did not settle')), 4000))]);
        return { raw: localStorage.getItem(oldKey), checked: storage.getState('checked', {}), sourcePresentDuringWrite };
      }, failure);
      assert.equal(result.sourcePresentDuringWrite, true);
      assert.deepEqual(result.checked, { 'sample-item': true });
      assert.equal(result.raw, failure === 'none' ? null : JSON.stringify({ 'sample-item': true }));
      // Reload without injected errors: either read the committed value or retry retained source.
      await page.reload();
      assert.deepEqual(await page.evaluate(async () => { const s = await import('/storage.js'); await s.initStorage(); return s.getState('checked', {}); }), { 'sample-item': true });
      await context.close();
    }
    const conflictContext = await browser.newContext({ ignoreHTTPSErrors: Boolean(tlsDir), serviceWorkers: 'block' });
    const conflictPage = await conflictContext.newPage(); await conflictPage.goto(base + '/harness');
    await conflictPage.evaluate(async () => {
      localStorage.setItem('careready_v2_checked', JSON.stringify({ original: true }));
      const s = await import('/storage.js'); await s.initStorage();
      localStorage.setItem('careready_v2_checked', JSON.stringify({ different: true }));
      localStorage.setItem('careready_v2_customItems', '{broken');
    });
    await conflictPage.reload();
    const conflict = await conflictPage.evaluate(async () => {
      const s = await import('/storage.js'); await s.initStorage();
      return { checked: s.getState('checked', {}), source: localStorage.getItem('careready_v2_checked'), broken: localStorage.getItem('careready_v2_customItems') };
    });
    assert.deepEqual(conflict.checked, { original: true });
    assert.equal(conflict.source, JSON.stringify({ different: true }));
    assert.equal(conflict.broken, '{broken');
    await conflictContext.close();
    // Capture the share payload in the test, never opening an external share target.
    async function appContext() {
      const context = await browser.newContext({ ignoreHTTPSErrors: Boolean(tlsDir), serviceWorkers: 'block' });
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === base) return route.continue();
        // Layout utilities only, for local functional checks; no CDN access.
        if (route.request().resourceType() === 'script') return route.fulfill({ contentType: 'text/javascript', body: "const style=document.createElement('style');style.textContent='.hidden{display:none!important}.flex{display:flex}';document.head.append(style);" });
        return route.abort();
      });
      return context;
    }
    const source = await appContext(); const page = await source.newPage();
    await page.addInitScript(() => Object.defineProperty(navigator, 'share', { value: async data => { window.testShare = data; } }));
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => document.querySelectorAll('input[type="checkbox"]').length >= 20);
    const items = [{ id: 'custom-sample', name: 'ま', categoryId: 'hygiene', applicable_locations: ['shortstay'], consumable: false }];
    await page.evaluate(async items => {
      const s = await import('/storage.js');
      s.setState('customItems', items);
      s.setState('customContainers', [{ id: 'cc_sample', name: 'テストの箱' }]);
      s.setState('containerNames', { box1: 'テストの箱名' });
      s.setState('checked', { 'custom-sample': true });
    }, items);
    await page.locator('#share-btn').click();
    const url = await page.evaluate(() => window.testShare.url);
    assert(new URL(url).searchParams.get('t'));
    const target = await appContext(); const other = await target.newPage();
    await other.goto(url); await other.locator('#import-ok').click();
    await other.waitForFunction(async () => (await import('/storage.js')).getState('customItems', []).length === 1);
    await other.reload();
    const restored = await other.evaluate(async () => {
      const s = await import('/storage.js'); await s.initStorage();
      return { items: s.getState('customItems', []), names: s.getState('containerNames', {}), boxes: s.getState('customContainers', []), checked: s.getState('checked', {}) };
    });
    assert.deepEqual(restored.items, items);
    assert.equal(restored.names.box1, 'テストの箱名');
    assert.equal(restored.boxes[0].name, 'テストの箱');
    assert.deepEqual(restored.checked, {}); // Sharing is a template, not a full-state backup.
    await other.goto(url); await other.locator('#import-ok').click();
    assert.equal(await other.evaluate(async () => (await import('/storage.js')).getState('customItems', []).length), 1);
    // A shared custom item must retain a reachable named outing on a fresh device.
    const outing = { id: 'so_share_sample', name: '合成のおでかけ', date: '2099-01-01' };
    await page.evaluate(async outing => {
      const s = await import('/storage.js');
      s.setState('specialOutings', [outing]);
      s.setState('customItems', [{ id: 'outing-sample', name: '合成の持ち物', categoryId: 'hygiene', applicable_locations: [outing.id] }]);
    }, outing);
    await page.locator('#share-btn').click();
    const outingUrl = await page.evaluate(() => window.testShare.url);
    const receiver = await appContext(); const received = await receiver.newPage();
    await received.goto(outingUrl); await received.locator('#import-ok').click();
    await received.waitForFunction(() => document.querySelector('#location-tabs').textContent.includes('合成のおでかけ'), null, { timeout: 5000 });
    await received.locator('#location-tabs button').filter({ hasText: '合成のおでかけ' }).first().click();
    await received.waitForFunction(() => document.querySelector('#checklist-container').textContent.includes('合成の持ち物'));
    await received.reload();
    await received.waitForFunction(() => document.querySelector('#location-tabs').textContent.includes('合成のおでかけ'));
    await received.goto(outingUrl); await received.locator('#import-ok').click();
    const importedOutings = await received.evaluate(async () => (await import('/storage.js')).getState('specialOutings', []));
    assert.equal(importedOutings.length, 1);
    assert.equal(importedOutings[0].name, outing.name);
    assert.equal(importedOutings[0].date || '', ''); // A shared template does not carry the sender's schedule.
    await receiver.close();
    await source.close(); await target.close();
    console.log(engine + ' Passed: failed/aborted/successful migration, conflicting/corrupt sources, reload recovery, local UI sharing, repeated import and share scope.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
