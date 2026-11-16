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
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      if (route.request().resourceType() === 'script') return route.fulfill({ contentType: 'text/javascript', body: "const s=document.createElement('style');s.textContent='.hidden{display:none!important}.flex{display:flex}';document.head.append(s);" });
      return route.abort();
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.print = () => {};
      window.open = url => { window.capturedShare = url; };
    });
    await page.goto(base + '/index.html');
    await page.waitForFunction(() => document.querySelectorAll('input[type=checkbox]').length >= 20);
    await page.evaluate(async () => {
      const s = await import('/storage.js');
      s.setState('specialOutings', [{ id: 'so_output', name: '合成のおでかけ' }]);
      s.setState('customItems', [
        { id: 'always-sample', name: '合成のいつもの持ち物', categoryId: 'hygiene', applicable_locations: ['shortstay'], myItem: true, quantity: 2 },
        { id: 'other-sample', name: '他の行き先だけの品物', categoryId: 'hygiene', applicable_locations: ['shortstay'] },
      ]);
    });
    await page.reload();
    await page.locator('#location-tabs button').filter({ hasText: '合成のおでかけ' }).first().click();
    await page.waitForFunction(() => document.querySelector('#checklist-container').textContent.includes('合成のいつもの持ち物'));
    await page.locator('#print-btn').click();
    await page.locator('#line-share-btn').click();
    const printed = await page.locator('#print-area').textContent();
    const shared = await page.evaluate(() => new URL(window.capturedShare).searchParams.get('text').split('\nhttp')[0]);
    const result = { printIncludesAlwaysItem: printed.includes('合成のいつもの持ち物'), lineIncludesAlwaysItem: shared.includes('合成のいつもの持ち物') };
    console.log(JSON.stringify(result));
    assert(!printed.includes('他の行き先だけの品物'));
    assert(!shared.includes('他の行き先だけの品物'));
    assert.deepEqual(result, { printIncludesAlwaysItem: true, lineIncludesAlwaysItem: true });
    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
