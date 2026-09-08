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
  const base = scheme + '://127.0.0.1:'+server.address().port;
  browser = await browserType.launch({headless:true});
  async function pageFor(fallback = false) {
   const context = await browser.newContext({ ignoreHTTPSErrors: Boolean(tlsDir),serviceWorkers:'block', viewport:{width:390,height:844}});
   await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    if (route.request().resourceType()==='script') return route.fulfill({contentType:'text/javascript',body:"const s=document.createElement('style');s.textContent='.hidden{display:none!important}.flex{display:flex}';document.head.append(s);"});
    return route.abort();
   });
   if (fallback) await context.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
   const page = await context.newPage();
   page.on('pageerror', error => console.error('Browser script error:', error.message));
   await page.goto(base+'/index.html');
   await page.waitForFunction(()=>document.querySelectorAll('input[type="checkbox"]').length>=20);
   return page;
  }
  const read = page => page.evaluate(async()=>{const s=await import('/storage.js');const b=await import('/lib/backup.js');return s.readBackupState([...b.BACKUP_KEYS,'diary','personName','memos']);});
  const seed = (page,data) => page.evaluate(async data=>{const s=await import('/storage.js');for(const [k,v] of Object.entries(data))s.setState(k,v);await s.readBackupState(Object.keys(data));},data);
  const source = await pageFor();
  await seed(source,{customItems:[{id:'custom-test',name:'合成タオル',categoryId:'hygiene',applicable_locations:['shortstay'],quantity:1}],customContainers:[{id:'cc_test',name:'合成箱'}],containers:{'custom-test':'cc_test'},checked:{'custom-test':true},returnChecked:{'custom-test':true},conditions:{laundry:true},diary:[{photo:'source-photo'}],personName:'source-person',memos:{x:'source-memo'}});
  const downloadPromise=source.waitForEvent('download');await source.locator('#backup-export').click();
  const download=await downloadPromise; const raw=fs.readFileSync(await download.path(),'utf8'); const backup=JSON.parse(raw);
  assert(!raw.includes('source-photo'));assert(!raw.includes('source-person'));assert(!raw.includes('source-memo'));
  const target=await pageFor();await seed(target,{checked:{original:true},diary:[{photo:'target-photo'}],personName:'target-person',memos:{x:'target-memo'}});
  const before=await read(target);
  async function preview(page=target,content=raw) {await page.locator('#backup-file').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(content)});await page.waitForFunction(()=>document.querySelector('#backup-dialog').open);}
  async function confirm() {const loaded=target.waitForEvent('load');await target.locator('#backup-confirm').click();await loaded;await target.waitForFunction(()=>!document.querySelector('#backup-export').disabled);}
  await preview(); await target.keyboard.press('Escape');assert.deepEqual(await read(target),before);
  await preview();await target.locator('#backup-cancel').click();assert.deepEqual(await read(target),before);
  await preview();assert(await target.locator('#backup-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));await confirm();
  let restored=await read(target);for(const [k,v]of Object.entries(backup.data))assert.deepEqual(restored[k],v,k);
  for(const k of ['diary','personName','memos'])assert.deepEqual(restored[k],before[k]);
  await preview();await confirm();assert.deepEqual(await read(target),restored);
  await target.locator('#backup-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{bad')});
  await target.waitForFunction(()=>document.querySelector('#backup-status').textContent.includes('読み込めません'));assert.deepEqual(await read(target),restored);
  await preview();const other=await target.context().newPage();await other.goto(base+'/index.html');await other.waitForFunction(()=>!document.querySelector('#backup-export').disabled);
  await seed(other,{checked:{otherTab:true}});await target.locator('#backup-confirm').click();await target.waitForFunction(()=>document.querySelector('#backup-error').textContent.includes('別の画面'));
  assert.deepEqual((await read(target)).checked,{otherTab:true});await target.locator('#backup-cancel').click();await other.close();
  for(const mode of ['throw','abort']) {
   const original=await read(target);await preview();
   await target.evaluate(mode=>{window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(args[1]==='containers'&&mode==='throw')throw new DOMException('quota','QuotaExceededError');const r=window.originalPut.apply(this,args);if(args[1]==='containers'&&mode==='abort')r.addEventListener('success',()=>this.transaction.abort());return r;};},mode);
   await target.locator('#backup-confirm').click();await target.waitForFunction(()=>document.querySelector('#backup-error').textContent.includes('元のデータ'));
   assert.deepEqual(await read(target),original);await target.reload();await target.waitForFunction(()=>!document.querySelector('#backup-export').disabled);assert.deepEqual(await read(target),original);
  }
  await preview();await confirm();assert.deepEqual((await read(target)).checked,backup.data.checked);
  const fallback=await pageFor(true);await seed(fallback,{checked:{fallbackOriginal:true}});const fallbackBefore=await read(fallback);
  await preview(fallback);await fallback.locator('#backup-confirm').click();await fallback.waitForFunction(()=>document.querySelector('#backup-error').textContent.includes('一括保存'));assert.deepEqual(await read(fallback),fallbackBefore);
  const failed=await pageFor();await failed.evaluate(async()=>{IDBObjectStore.prototype.put=function(){throw new DOMException('quota','QuotaExceededError');};const s=await import('/storage.js');s.setState('checked',{notSaved:true});});
  await failed.locator('#backup-export').click();await failed.waitForFunction(()=>document.querySelector('#backup-status').textContent.includes('保存に失敗した操作'));
  console.log(engine + ' Passed: download scope, cancel/Escape, replace/reload, repeated restore, invalid file, concurrent-tab conflict, thrown/aborted writes and recovery; mobile dialog width; fallback restore refusal and unsaved-state export refusal. CDN layout and service worker offline behavior not tested.');
 } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
