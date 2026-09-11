// Uses an existing Playwright installation; synthetic data and loopback traffic only.
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
const allowed = new Set(['index.html','app.js','storage.js','data.json','manifest.webmanifest', ...fs.readdirSync(path.join(root,'lib')).filter(x=>x.endsWith('.js')).map(x=>'lib/'+x)]);
const server = transport.createServer(serverOptions, (req,res) => {
 const name = new URL(req.url,'http://localhost').pathname.slice(1);
 if (!allowed.has(name)) { res.writeHead(204); res.end(); return; }
 res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.json') ? 'application/json' : 'text/html');
 res.end(fs.readFileSync(path.join(root,name)));
});
(async () => {
 let browser;
 try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=scheme+'://127.0.0.1:'+server.address().port;
  browser=await browserType.launch({headless:true});
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844},ignoreHTTPSErrors:Boolean(tlsDir)});
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin===base)return route.continue();
   if(url.hostname==='cdn.tailwindcss.com')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(process.argv[3],'utf8')});
   return route.abort();
  });
  const page=await context.newPage();
  await page.goto(base+'/index.html');
  await page.getByRole('button',{name:'はじめる',exact:true}).click();
  // 残りがある状態で準備完了を選ぶと、強制せず確認へ戻れる。
  await page.locator('#ready-btn').click();
  assert(await page.locator('#ready-confirm-dialog').evaluate(el=>el.open),'Remaining items must open the completion confirmation');
  await page.locator('#ready-confirm-review').click();
  assert(await page.locator('#ready-confirm-dialog').evaluate(el=>!el.open),'Review must close the completion confirmation');
  await page.locator('#location-tabs button').filter({hasText:'デイサービス'}).click();
  await page.locator('#mode-category').click();
  const add=page.getByRole('button',{name:'＋ 追加',exact:true}).first();
  await add.click();
  await page.locator('#modal-item-name').fill('テスト用タオル');
  await page.locator('#modal-category').focus();
  await page.keyboard.press('Escape');
  assert(await page.locator('#add-modal').isHidden(),'Escape must cancel from category selection');
  await add.click();
  await page.locator('#modal-item-name').fill('テスト用タオル');
  await page.locator('#modal-save').focus();
  await page.keyboard.press('Tab');
  // Native dialogs may visit browser chrome between the last and first field.
  if (await page.evaluate(()=>document.activeElement===document.body)) await page.keyboard.press('Tab');
  assert(await page.locator('#add-modal').evaluate(el=>el.contains(document.activeElement)),'Tab must not enter the background page');
  await page.locator('#modal-qty-plus').click();
  await page.locator('#modal-save').click();
  await page.locator('#mode-container').click();
  page.once('dialog',d=>d.accept('テスト用バッグ'));
  await page.getByRole('button',{name:/＋.*入れ物を追加/}).click();
  const item=page.locator('[data-pack-item]').filter({hasText:'テスト用タオル'});
  await item.click();
  assert.equal(await item.getAttribute('data-pack-item'),'checked');
  assert((await item.textContent()).includes('テスト用バッグ'));
  await page.reload();
  await page.locator('#mode-container').click();
  await page.locator('#location-tabs button').filter({hasText:'デイサービス'}).click();
  assert.equal(await item.getAttribute('data-pack-item'),'checked');
  assert((await item.textContent()).includes('テスト用バッグ'));
  await item.click();
  assert.equal(await item.getAttribute('data-pack-item'),'unchecked');
  await page.locator('#mode-category').click();await add.click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert(await page.locator('#modal-save').evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom<=innerHeight;}),'Save must fit the mobile viewport');
  await page.screenshot({path:'/private/tmp/careready-preparation-dialog.png',fullPage:true});
  console.log('Passed: fresh start, destination, add item, Escape, focus containment, quantity, new bag, pack/unpack and reload persistence, narrow-screen dialog.');
 } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
