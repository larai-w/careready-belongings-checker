// tests/share.test.js — lib/share.js のユニットテスト
// 依存パッケージ不要。実行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeShareData, decodeShareData, isValidShareData, mergeById } from '../lib/share.js';

// ---------- encodeShareData / decodeShareData ----------

test('encodeShareData/decodeShareData: ラウンドトリップ(日本語含む)', () => {
    const data = {
        customItems: [{ id: 'custom_1', name: '歯ブラシ', categoryId: 'hygiene' }],
        containerNames: { box1: '青い箱' },
        customContainers: [{ id: 'cc_1', name: 'キャリーバッグ' }],
    };
    const encoded = encodeShareData(data);
    assert.equal(typeof encoded, 'string');
    assert.ok(encoded.length > 0);
    const decoded = decodeShareData(encoded);
    assert.deepEqual(decoded, data);
});

test('encodeShareData: 空オブジェクトもラウンドトリップ', () => {
    const encoded = encodeShareData({});
    assert.deepEqual(decodeShareData(encoded), {});
});

test('decodeShareData: 不正なBase64は例外を投げる', () => {
    assert.throws(() => decodeShareData('!!!invalid!!!'));
});

// ---------- isValidShareData ----------

test('isValidShareData: customItemsがあれば有効', () => {
    assert.equal(isValidShareData({ customItems: [{ id: 'a' }] }), true);
});

test('isValidShareData: containerNamesがあれば有効', () => {
    assert.equal(isValidShareData({ containerNames: { box1: '箱' } }), true);
});

test('isValidShareData: customContainersがあれば有効', () => {
    assert.equal(isValidShareData({ customContainers: [{ id: 'cc_1' }] }), true);
});

test('isValidShareData: 空データは無効', () => {
    assert.equal(isValidShareData({}), false);
    assert.equal(isValidShareData({ customItems: [] }), false);
    assert.equal(isValidShareData({ containerNames: {} }), false);
    assert.equal(isValidShareData(null), false);
    assert.equal(isValidShareData(undefined), false);
    assert.equal(isValidShareData('string'), false);
});

// ---------- mergeById ----------

test('mergeById: 重複IDはスキップしてマージ', () => {
    const existing = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    const incoming = [{ id: 'b', name: 'B2' }, { id: 'c', name: 'C' }];
    const merged = mergeById(existing, incoming);
    assert.equal(merged.length, 3);
    assert.deepEqual(merged.map((i) => i.id), ['a', 'b', 'c']);
    // 既存のBが維持される(上書きされない)
    assert.equal(merged[1].name, 'B');
});

test('mergeById: 空配列・null入力に対応', () => {
    assert.deepEqual(mergeById([], [{ id: 'x' }]), [{ id: 'x' }]);
    assert.deepEqual(mergeById([{ id: 'x' }], []), [{ id: 'x' }]);
    assert.deepEqual(mergeById(null, [{ id: 'y' }]), [{ id: 'y' }]);
    assert.deepEqual(mergeById([{ id: 'x' }], null), [{ id: 'x' }]);
});

test('mergeById: idなしアイテムは無視', () => {
    const merged = mergeById([{ id: 'a' }], [{ name: 'no-id' }, { id: 'b' }]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((i) => i.id), ['a', 'b']);
});