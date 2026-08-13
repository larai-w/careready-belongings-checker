// tests/checklist.test.js — lib/checklist.js のユニットテスト
// 依存パッケージ不要。実行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isValidData,
    isConditionActive,
    isItemVisible,
    getFacilityHideSet,
    getFacilityItemsByCategory,
    isSpecialOuting,
} from '../lib/checklist.js';

// ---------- isValidData ----------

test('isValidData: 有効なデータ', () => {
    assert.equal(isValidData({ locations: [{ id: 'a' }], categories: [] }), true);
});

test('isValidData: 無効なデータ', () => {
    assert.equal(isValidData(null), false);
    assert.equal(isValidData({}), false);
    assert.equal(isValidData({ locations: [], categories: [] }), false);
    assert.equal(isValidData({ locations: [{ id: 'a' }] }), false);
    assert.equal(isValidData({ categories: [] }), false);
});

// ---------- isConditionActive ----------

const CONDITIONS = [
    { id: 'bath', name: '入浴', default: true },
    { id: 'meal', name: '食事', default: false },
];

test('isConditionActive: 保存状態があればそれを優先', () => {
    assert.equal(isConditionActive('bath', CONDITIONS, { bath: false }), false);
    assert.equal(isConditionActive('meal', CONDITIONS, { meal: true }), true);
});

test('isConditionActive: 保存状態がなければデフォルト', () => {
    assert.equal(isConditionActive('bath', CONDITIONS, {}), true);
    assert.equal(isConditionActive('meal', CONDITIONS, {}), false);
});

test('isConditionActive: 条件が存在しない・conditions未指定はtrue', () => {
    assert.equal(isConditionActive('unknown', CONDITIONS, {}), true);
    assert.equal(isConditionActive('bath', null, {}), true);
    assert.equal(isConditionActive('bath', [], {}), true);
});

// ---------- isItemVisible ----------

test('isItemVisible: conditionなしは常に表示', () => {
    assert.equal(isItemVisible({ id: 'a' }, () => false), true);
    assert.equal(isItemVisible(null, () => false), true);
});

test('isItemVisible: condition判定関数に従う', () => {
    const item = { id: 'a', condition: 'bath' };
    assert.equal(isItemVisible(item, () => true), true);
    assert.equal(isItemVisible(item, () => false), false);
});

test('isItemVisible: 判定関数未指定は表示', () => {
    assert.equal(isItemVisible({ id: 'a', condition: 'bath' }, null), true);
});

// ---------- getFacilityHideSet ----------

test('getFacilityHideSet: hide配列をSet化', () => {
    const tpl = { overrides: { hide: ['i1', 'i2'] } };
    const s = getFacilityHideSet(tpl);
    assert.equal(s.has('i1'), true);
    assert.equal(s.has('i2'), true);
    assert.equal(s.size, 2);
});

test('getFacilityHideSet: テンプレなし・hideなしは空Set', () => {
    assert.equal(getFacilityHideSet(null).size, 0);
    assert.equal(getFacilityHideSet({}).size, 0);
    assert.equal(getFacilityHideSet({ overrides: {} }).size, 0);
});

// ---------- getFacilityItemsByCategory ----------

test('getFacilityItemsByCategory: カテゴリ別にグループ化', () => {
    const tpl = {
        items: [
            { id: 'f1', name: 'A', categoryId: 'hygiene' },
            { id: 'f2', name: 'B', categoryId: 'hygiene' },
            { id: 'f3', name: 'C' },
        ],
    };
    const byCat = getFacilityItemsByCategory(tpl);
    assert.equal(byCat.hygiene.length, 2);
    assert.equal(byCat.__facility__.length, 1);
    assert.equal(byCat.hygiene[0].isFacility, true);
});

test('getFacilityItemsByCategory: テンプレなしは空オブジェクト', () => {
    assert.deepEqual(getFacilityItemsByCategory(null), {});
    assert.deepEqual(getFacilityItemsByCategory({}), {});
});

// ---------- isSpecialOuting ----------

test('isSpecialOuting: so_プレフィックス判定', () => {
    assert.equal(isSpecialOuting('so_123'), true);
    assert.equal(isSpecialOuting('shortstay'), false);
    assert.equal(isSpecialOuting(''), false);
    assert.equal(isSpecialOuting(null), false);
    assert.equal(isSpecialOuting(123), false);
});