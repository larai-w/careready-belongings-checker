// tests/admin-template.test.js — lib/admin-template.js のユニットテスト
// 依存パッケージ不要。実行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    fmtDate,
    mapLoginError,
    shareUrlFor,
    normalizeFacRow,
    buildTemplatePayload
} from '../lib/admin-template.js';

// ---------- fmtDate ----------

test('fmtDate: 有効なepoch秒は YYYY/MM/DD HH:mm 形式', () => {
    const epoch = 1700000000; // 2023-11-15T00:13:20Z (ローカル時刻で表示)
    const result = fmtDate(epoch);
    assert.match(result, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);

    // ローカル時刻と一致すること(同じDateロジックで検証)
    const d = new Date(epoch * 1000);
    const p = (n) => String(n).padStart(2, '0');
    const expected = d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    assert.equal(result, expected);
});

test('fmtDate: 文字列のepoch秒も受け付ける', () => {
    assert.match(fmtDate('1700000000'), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
});

test('fmtDate: 空値・不正値は空文字', () => {
    assert.equal(fmtDate(null), '');
    assert.equal(fmtDate(undefined), '');
    assert.equal(fmtDate(0), '');
    assert.equal(fmtDate('abc'), '');
});

// ---------- mapLoginError ----------

test('mapLoginError: Cognitoエラー種別ごとに日本語メッセージ', () => {
    assert.equal(
        mapLoginError({ __type: 'NotAuthorizedException' }),
        'メールアドレスまたはパスワードが違います。'
    );
    assert.equal(
        mapLoginError({ __type: 'prefix#UserNotFoundException' }),
        'アカウントが見つかりません。'
    );
    assert.equal(
        mapLoginError({ __type: 'PasswordResetRequiredException' }),
        'パスワードの再設定が必要です。管理者にお問い合わせください。'
    );
});

test('mapLoginError: 未知のエラー・null は汎用メッセージ', () => {
    assert.equal(mapLoginError({ __type: 'SomethingElse' }), 'ログインに失敗しました。');
    assert.equal(mapLoginError({}), 'ログインに失敗しました。');
    assert.equal(mapLoginError(null), 'ログインに失敗しました。');
});

// ---------- shareUrlFor ----------

test('shareUrlFor: baseUrl に ?fc=コード を付与', () => {
    assert.equal(
        shareUrlFor('https://veai.jp/ready/', 'ABC123'),
        'https://veai.jp/ready/?fc=ABC123'
    );
});

test('shareUrlFor: コードの特殊文字はURLエンコード', () => {
    assert.equal(
        shareUrlFor('https://veai.jp/ready/', 'a b&c'),
        'https://veai.jp/ready/?fc=a%20b%26c'
    );
});

test('shareUrlFor: コード空でも破綻しない', () => {
    assert.equal(shareUrlFor('https://veai.jp/ready/', ''), 'https://veai.jp/ready/?fc=');
});

// ---------- normalizeFacRow ----------

test('normalizeFacRow: 既存idは保持し locations は Set になる', () => {
    const row = normalizeFacRow(
        { id: 'fac_1', name: '歯ブラシ', quantity: '1本', applicable_locations: ['shortstay', 'hospital'] },
        () => 'gen_should_not_be_used'
    );
    assert.equal(row.id, 'fac_1');
    assert.equal(row.name, '歯ブラシ');
    assert.equal(row.quantity, '1本');
    assert.ok(row.locations instanceof Set);
    assert.deepEqual(Array.from(row.locations).sort(), ['hospital', 'shortstay']);
});

test('normalizeFacRow: id が無ければ genId で採番', () => {
    const row = normalizeFacRow({ name: 'タオル' }, () => 'fac_gen_1');
    assert.equal(row.id, 'fac_gen_1');
    assert.equal(row.name, 'タオル');
    assert.equal(row.quantity, '');
    assert.equal(row.locations.size, 0);
});

test('normalizeFacRow: null データでも破綻しない', () => {
    const row = normalizeFacRow(null, () => 'fac_x');
    assert.equal(row.id, 'fac_x');
    assert.equal(row.name, '');
    assert.equal(row.locations.size, 0);
});

// ---------- buildTemplatePayload ----------

test('buildTemplatePayload: 基本形(name/items/overrides)', () => {
    const payload = buildTemplatePayload(
        { name: ' ショートステイ用 ' },
        [
            { id: 'fac_1', name: ' 歯ブラシ ', quantity: ' 1本 ', locations: new Set(['shortstay']) },
            { id: 'fac_2', name: '', quantity: 'x', locations: new Set() } // 空名は除外
        ],
        ['item_a', 'item_b']
    );
    assert.equal(payload.name, 'ショートステイ用');
    assert.equal(payload.items.length, 1);
    assert.deepEqual(payload.items[0], {
        id: 'fac_1',
        name: '歯ブラシ',
        quantity: '1本',
        applicable_locations: ['shortstay']
    });
    assert.deepEqual(payload.overrides.hide, ['item_a', 'item_b']);
    // 任意フィールドが空ならキー自体が無い
    assert.equal('facilityName' in payload, false);
    assert.equal('facilityPhone' in payload, false);
    assert.equal('facilityAddress' in payload, false);
    assert.equal('note' in payload.overrides, false);
});

test('buildTemplatePayload: 任意フィールドは trim 後に入っていれば含む', () => {
    const payload = buildTemplatePayload(
        {
            name: 'L',
            facilityName: ' ○○施設 ',
            facilityPhone: ' 000-000-0000 ',
            facilityAddress: ' ○○県 ',
            note: ' 名前を書いてください '
        },
        [],
        []
    );
    assert.equal(payload.facilityName, '○○施設');
    assert.equal(payload.facilityPhone, '000-000-0000');
    assert.equal(payload.facilityAddress, '○○県');
    assert.equal(payload.overrides.note, '名前を書いてください');
    assert.deepEqual(payload.overrides.hide, []);
});

test('buildTemplatePayload: locations が配列でも動く', () => {
    const payload = buildTemplatePayload(
        { name: 'L' },
        [{ id: 'fac_1', name: 'x', quantity: '', locations: ['hospital'] }],
        []
    );
    assert.deepEqual(payload.items[0].applicable_locations, ['hospital']);
});

test('buildTemplatePayload: null 引数でも破綻しない', () => {
    const payload = buildTemplatePayload(null, null, null);
    assert.equal(payload.name, '');
    assert.deepEqual(payload.items, []);
    assert.deepEqual(payload.overrides.hide, []);
});

test('buildTemplatePayload: hide 配列はコピーされ入力側の変更に影響されない', () => {
    const hidden = ['a'];
    const payload = buildTemplatePayload({ name: 'L' }, [], hidden);
    hidden.push('b');
    assert.deepEqual(payload.overrides.hide, ['a']);
});