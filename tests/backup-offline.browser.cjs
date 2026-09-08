// Real service workers; isolated contexts and synthetic state. CDN script supplied as argv[3].
const assert=require('node:assert/strict');
const fs=require('node:fs');const http=require('node:http');const path=require('node:path');const cp=require('node:child_process');
const engine=process.env.CAREREADY_TEST_BROWSER||'chromium';
if(!['chromium','webkit'].includes(engine))throw new Error('Unsupported test browser');
const browserType=require(process.argv[2]||'playwright')[engine];
const tlsDir = process.env.CAREREADY_TEST_TLS_DIR;
const transport = tlsDir ? require('node:https') : http;
const serverOptions = tlsDir ? {key:fs.readFileSync(path.join(tlsDir,'key.pem')),cert:fs.readFileSync(path.join(tlsDir,'cert.pem'))} : {};
const scheme = tlsDir ? 'https' : 'http';
const root=path.resolve(__dirname,'..');const cdn=fs.readFileSync(process.argv[3],'utf8');
const files=['index.html','privacy.html','app.js','storage.js','sw.js','data.json','manifest.webmanifest',...fs.readdirSync(path.join(root,'lib')).map(x=>'lib/'+x),...fs.readdirSync(path.join(root,'icons')).map(x=>'icons/'+x)];
const current=new Map(files.filter(x=>fs.statSync(path.join(root,x)).isFile()).map(x=>[x,fs.readFileSync(path.join(root,x))]));
const old=new Map();for(const name of current.keys()){try{old.set(name,cp.execFileSync('git',['show','HEAD:'+name],{cwd:root,stdio:['ignore','pipe','ignore']}));}catch{}}
const offlineMode=process.env.CAREREADY_TEST_OFFLINE_MODE||'browser';
if(!['browser','network-failure'].includes(offlineMode))throw new Error('Unsupported offline mode');
let networkDown=false;
let version='old', broken=false;
const server=transport.createServer(serverOptions, (req,res)=>{
 if(networkDown){req.socket.destroy();return;}
 let name=new URL(req.url,'http://localhost').pathname.replace(/^\/ready\//,'');if(!name)name='index.html';
 let data=(version==='old'?old:current).get(name);
 if(!data || broken&&name==='lib/backup.js'){res.writeHead(404);res.end();return;}
 if(name==='sw.js')data=Buffer.from(data.toString().replace(/const CACHE_NAME = '[^']*'/,"const CACHE_NAME = 'careready-test-"+version+"'"));
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':name.endsWith('.json')?'application/json':'text/html');res.end(data);
});
(async()=>{let browser;try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=scheme + '://127.0.0.1:'+server.address().port;
 browser=await browserType.launch({headless:true});let offline=false;
 const context=await browser.newContext({ ignoreHTTPSErrors: Boolean(tlsDir),serviceWorkers:'allow',viewport:{width:390,height:844}});
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===base)return route.continue();if(url.hostname==='cdn.tailwindcss.com'&&!offline)return route.fulfill({contentType:'text/javascript',body:cdn});return route.abort();});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const ready=async()=>{await page.waitForFunction(()=>document.querySelectorAll('input[type="checkbox"]').length>=20);await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);};
 await page.goto(base+'/ready/');await ready();await page.getByRole('button',{name:'はじめる',exact:true}).click();
 await page.evaluate(async()=>{const s=await import('./storage.js');s.setState('checked',{'cloth_top_bottom':true});s.setState('customItems',[{id:'custom-demo',name:'お試しタオル',categoryId:'hygiene',applicable_locations:['shortstay'],quantity:1}]);});
 await page.waitForFunction(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('careready');q.onsuccess=()=>r(q.result)});return new Promise(r=>{const q=db.transaction('kv').objectStore('kv').get('checked');q.onsuccess=()=>{db.close();r(q.result?.cloth_top_bottom===true)}})});
 await page.reload();await ready();
 await page.evaluate(async()=>{const c=await caches.open('other-app-test');await c.put('/unrelated',new Response('keep'));});
 // A broken installation must leave the old worker and existing data available.
 version='new';broken=true;await page.evaluate(async()=>{
  const reg=await navigator.serviceWorker.ready;
  const failed=new Promise((resolve,reject)=>reg.addEventListener('updatefound',()=>{
   const worker=reg.installing;worker.addEventListener('statechange',()=>{
    if(worker.state==='redundant')resolve();
    if(worker.state==='activated')reject(new Error('Incomplete release activated'));
   });
  },{once:true}));
  await reg.update();await failed;
 });
 assert((await page.evaluate(()=>caches.keys())).includes('careready-test-old'));
 assert.equal(await page.evaluate(async()=>(await import('./storage.js')).getState('checked',{}).cloth_top_bottom),true);
 // Then deliver the complete release, just as the deployment changes the cache hash.
 broken=false;version='complete';const load=page.waitForEvent('load');await page.evaluate(async()=>{await(await navigator.serviceWorker.ready).update()});await load;await ready();
 await page.waitForFunction(()=>document.querySelector('#backup-export')&&!document.querySelector('#backup-export').disabled);
 assert.equal(await page.evaluate(async()=>(await import('./storage.js')).getState('checked',{}).cloth_top_bottom),true);
 assert.equal(await page.evaluate(async()=>(await import('./storage.js')).getState('customItems',[]).length),1);
 await page.waitForFunction(async()=> (await navigator.serviceWorker.getRegistration()).active?.state==='activated');
 const stored=await page.evaluate(()=>caches.keys());console.log('Update caches:',stored);assert(!stored.includes('careready-test-old'));assert(stored.includes('careready-test-complete'));assert(stored.includes('other-app-test'));
 await page.locator('.backup-link').click();await page.locator('#backup').screenshot({path:`/private/tmp/${engine}-careready-backup-light.png`});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const downloadP=page.waitForEvent('download');await page.locator('#backup-export').click();const download=await downloadP;const raw=fs.readFileSync(await download.path(),'utf8');
 // Now disconnect completely; the real worker, rather than a mocked fetch, serves the app.
 offline=true;networkDown=true;if(offlineMode==='browser')await context.setOffline(true);await page.reload();await ready();
 await page.waitForFunction(()=>document.querySelector('#backup-export')&&!document.querySelector('#backup-export').disabled);
 const style=await page.evaluate(()=>({hidden:getComputedStyle(document.querySelector('#import-banner')).display,backup:getComputedStyle(document.querySelector('#backup')).backgroundColor}));
 console.log('Offline styles:',JSON.stringify(style));
 await page.evaluate(async()=>{const s=await import('./storage.js');s.setState('checked',{});await s.readBackupState(['checked']);});
 await page.locator('#backup-file').setInputFiles({name:'demo.json',mimeType:'application/json',buffer:Buffer.from(raw)});
 await page.waitForFunction(()=>document.querySelector('#backup-dialog').open);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'backup-cancel');
 await page.locator('#backup-dialog').screenshot({path:`/private/tmp/${engine}-careready-backup-confirm.png`});
 const restored=page.waitForEvent('load');await page.locator('#backup-confirm').click();await restored;await ready();
 assert((await page.locator('#backup-status').textContent()).includes('復元しました'));
 assert.equal(await page.evaluate(async()=>(await import('./storage.js')).getState('checked',{}).cloth_top_bottom),true);
 await page.locator('#backup').screenshot({path:`/private/tmp/${engine}-careready-backup-offline.png`});
 assert.equal(style.hidden,'none','CDN styling must remain available offline, including hidden dialogs');
 assert.deepEqual(errors,[]);
 // Fresh installation must also survive disconnecting before any controlled reload.
 offline=false;networkDown=false;const fresh=await browser.newContext({ ignoreHTTPSErrors: Boolean(tlsDir),serviceWorkers:'allow',viewport:{width:390,height:844}});
 await fresh.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===base)return route.continue();if(u.hostname==='cdn.tailwindcss.com'&&!offline)return route.fulfill({contentType:'text/javascript',body:cdn});return route.abort();});
 const first=await fresh.newPage();await first.goto(base+'/ready/');await first.waitForFunction(()=>navigator.serviceWorker.controller!==null&&document.querySelector('#backup-export')&&!document.querySelector('#backup-export').disabled);
 await first.getByRole('button',{name:'はじめる',exact:true}).click();
 offline=true;networkDown=true;if(offlineMode==='browser')await fresh.setOffline(true);await first.reload();await first.waitForFunction(()=>document.querySelectorAll('input[type="checkbox"]').length>=20);
 assert.equal(await first.locator('#import-banner').evaluate(el=>getComputedStyle(el).display),'none','First-install offline styling');
 await fresh.close();
 console.log(engine + ' (' + offlineMode + ') Passed: real SW failed-install retention, HEAD-to-working-tree update, state preservation, old cache removal, download, offline load/restore, persisted completion notice, mobile width, cancel focus, first-install offline styling and other-app cache preservation.');
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1});
