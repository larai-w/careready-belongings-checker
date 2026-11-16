// Run the existing E2E page in real time, without accelerating IndexedDB timers.
// Only a fresh Chrome process/profile and loopback target are used.
const { spawn } = require('node:child_process');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  const url = new URL(process.argv[2]);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw new Error('Only loopback test URLs are allowed');
  const output = process.argv[3];
  if (!output) throw new Error('A DOM output path is required');
  const limit = Number(process.env.CAREREADY_E2E_TIMEOUT_MS || 180000);
  if (!Number.isFinite(limit) || limit < 100 || limit > 180000) throw new Error('Invalid E2E timeout');
  const chrome = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  const profile = await mkdtemp(join(tmpdir(), 'careready-e2e-'));
  let child, lastDOM = '', failure;
  const pending = new Map();
  let sequence = 0;
  function rejectPending(error) {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  try {
    child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--disable-background-networking', '--disable-default-apps', '--no-first-run',
      '--remote-debugging-pipe', '--user-data-dir=' + profile],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    child.on('error', rejectPending);
    child.stdio[3].on('error', rejectPending);
    child.stdio[4].on('error', rejectPending);
    child.on('exit', () => rejectPending(new Error('Chrome exited before the report completed')));
    let buffer = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', chunk => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\0')) >= 0) {
        const message = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
    });
    function send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Chrome protocol timeout: ' + method)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
      });
    }
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url: url.href }, sessionId);
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression: "JSON.stringify({log:document.querySelector('pre#log')?.textContent||'',dom:document.documentElement.outerHTML})",
        returnByValue: true,
      }, sessionId);
      if (exceptionDetails) throw new Error('Cannot read the E2E report');
      const snapshot = JSON.parse(result.value);
      lastDOM = snapshot.dom;
      if (snapshot.log.trimEnd().split('\n').at(-1) === 'DONE') return;
      await delay(100);
    }
    throw new Error('E2E did not complete within ' + limit + 'ms of real time');
  } catch (error) { failure = error; }
  finally {
    try { await writeFile(output, lastDOM); }
    finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, delay(2000)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      }
      rejectPending(new Error('Chrome closed'));
      await rm(profile, { recursive: true, force: true });
    }
  }
  if (failure) throw failure;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
