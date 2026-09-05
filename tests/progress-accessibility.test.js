// 進捗表示は視覚的なバーだけでなく、支援技術にも状態を伝える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const HTML = readFileSync(new URL('index.html', ROOT), 'utf8');
const APP = readFileSync(new URL('app.js', ROOT), 'utf8');

test('準備進捗バーにARIAの状態属性がある', () => {
    assert.match(HTML, /id="progress-bar-wrap"[^>]*role="progressbar"/);
    assert.match(HTML, /aria-label="持ち物の準備の進み具合"/);
    assert.match(HTML, /aria-valuemin="0"/);
    assert.match(HTML, /aria-valuemax="1"/);
    assert.match(HTML, /aria-valuenow="0"/);
});

test('チェック数の更新時にARIAの現在値と最大値を更新する', () => {
    const start = APP.indexOf('function updateProgress()');
    const body = APP.slice(start, start + 1800);
    assert.match(body, /setAttribute\('aria-valuemax'/);
    assert.match(body, /setAttribute\('aria-valuenow'/);
    assert.match(body, /Math\.max\(total, 1\)/);
});
