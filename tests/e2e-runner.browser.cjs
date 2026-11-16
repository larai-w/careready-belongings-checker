// Exercise the real Chrome runner; all fixtures and browser data are temporary.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const http = require('node:http');
const runner = resolve(__dirname, '../scripts/run_browser_e2e.cjs');
function command(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careready-runner-test-'));
  const server = http.createServer((req, res) => {
    const log = req.url === '/failed' ? 'FAIL: intentional fixture\nE2E_RESULT: FAILURES=1\nDONE' : 'PASS: delayed fixture\nE2E_RESULT: ALL_PASS\nDONE';
    res.setHeader('Content-Type', 'text/html');
    res.end('<pre id="log">START</pre>' + (req.url === '/hang' ? '' : '<script>setTimeout(()=>document.querySelector("pre").textContent=' + JSON.stringify(log) + ',600)</script>'));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const env = { ...process.env, TMPDIR: directory, CAREREADY_E2E_TIMEOUT_MS: '5000' };
    const successFile = join(directory, 'success.html');
    const started = Date.now();
    const success = await command(process.execPath, [runner, base + '/delayed', successFile], env);
    assert.equal(success.code, 0, success.stderr);
    assert(Date.now() - started >= 600);
    const report = resolve(__dirname, '../scripts/report_e2e.py');
    assert.equal((await command('python3', [report, successFile], env)).code, 0);
    const failedFile = join(directory, 'failed.html');
    assert.equal((await command(process.execPath, [runner, base + '/failed', failedFile], env)).code, 0);
    assert.equal((await command('python3', [report, failedFile], env)).code, 1);
    const timeoutFile = join(directory, 'timeout.html');
    const timeout = await command(process.execPath, [runner, base + '/hang', timeoutFile], { ...env, CAREREADY_E2E_TIMEOUT_MS: '500' });
    assert.equal(timeout.code, 1);
    assert(timeout.stderr.includes('did not complete'));
    assert((await readFile(timeoutFile, 'utf8')).includes('START'));
    const rejected = await command(process.execPath, [runner, 'https://example.com', join(directory, 'external.html')], env);
    assert.equal(rejected.code, 1);
    assert(rejected.stderr.includes('Only loopback'));
    assert(!(await readdir(directory)).some(name => name.startsWith('careready-e2e-')), 'runner must remove its temporary profiles');
    console.log('PASS: delayed completion, assertion failure, timeout with diagnostic DOM, external URL rejection and profile cleanup');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
