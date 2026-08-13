// tests/ocr-match.test.js — lib/ocr-match.js のユニットテスト
// 依存パッケージ不要。実行: node --test tests/
// (ビルドなし方針のため node:test + assert のみ使用)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    normalizeOcrText,
    similarity,
    inferOcrCategory,
    isKnownOcrItem,
    guessQuantity,
} from '../lib/ocr-match.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appData = JSON.parse(readFileSync(join(__dirname, '..', 'data.json'), 'utf8'));
const categories = appData.categories;

// ---------- normalizeOcrText ----------

test('normalizeOcrText: 全角英数・区切り記号・空白を除去', () => {
    assert.equal(normalizeOcrText('歯ブラシ　２本'), '歯ブラシ2本');
    assert.equal(normalizeOcrText('保険証・診察券'), '保険証診察券');
    assert.equal(normalizeOcrText('お薬（処方）'), 'オ薬処方'); // ひらがな→カタカナ統一
    assert.equal(normalizeOcrText(''), '');
    assert.equal(normalizeOcrText(null), '');
});

test('normalizeOcrText: NFKCで異体字・半角カナを統一', () => {
    // ㈱ → (株) → 記号除去で「株」
    assert.equal(normalizeOcrText('ﾊﾟｼﾞｬﾏ'), 'パジャマ');
    assert.equal(normalizeOcrText('ﾃｨｯｼｭ'), 'ティッシュ');
});

// ---------- similarity ----------

test('similarity: 同一文字列は1、空は0', () => {
    assert.equal(similarity('歯ブラシ', '歯ブラシ'), 1);
    assert.equal(similarity('', '歯ブラシ'), 0);
    assert.equal(similarity('歯ブラシ', ''), 0);
});

test('similarity: 表記揺れは高スコア、無関係は低スコア', () => {
    // 1文字欠け・送り仮名違いは0.5以上
    assert.ok(similarity('歯ブラシ', '歯ぶらし') >= 0.5, '歯ブラシ vs 歯ぶらし');
    assert.ok(similarity('パジャマ', 'パジャマ上下') >= 0.5, 'パジャマ vs パジャマ上下');
    // 無関係な語は低い
    assert.ok(similarity('歯ブラシ', '保険証') < 0.3, '歯ブラシ vs 保険証');
});

// ---------- inferOcrCategory ----------

test('inferOcrCategory: カタログ完全一致は該当カテゴリ', () => {
    // data.json の実カテゴリに依存する検証
    assert.equal(inferOcrCategory('歯ブラシ', categories), 'hygiene');
    assert.equal(inferOcrCategory('パジャマ', categories), 'clothing');
    assert.equal(inferOcrCategory('保険証', categories), 'documents');
});

test('inferOcrCategory: 部分一致・表記揺れでも推定できる', () => {
    // 包含: 「歯ブラシ(大人用)」にはカタログ名「歯ブラシ」が含まれる
    assert.equal(inferOcrCategory('歯ブラシ（大人用）', categories), 'hygiene');
    // 表記揺れ: 濁点落ち
    assert.equal(inferOcrCategory('歯ふらし', categories), 'hygiene');
});

test('inferOcrCategory: カタログ外はヒント語で推定、未知はothers', () => {
    assert.equal(inferOcrCategory('カーディガン', categories), 'clothing'); // ヒント語
    assert.equal(inferOcrCategory('まったく未知の品XYZ', categories), 'others');
    assert.equal(inferOcrCategory('', categories), 'others');
});

test('inferOcrCategory: categories未指定でもヒント語で動く', () => {
    assert.equal(inferOcrCategory('タオル', []), 'hygiene');
    assert.equal(inferOcrCategory('未知の品', null), 'others');
});

// ---------- isKnownOcrItem ----------

test('isKnownOcrItem: 既存名との包含・あいまい一致', () => {
    const known = ['歯ブラシ', 'パジャマ', '保険証・診察券'];
    assert.equal(isKnownOcrItem('歯ブラシ', known), true);
    assert.equal(isKnownOcrItem('歯ぶらし', known), true); // あいまい
    assert.equal(isKnownOcrItem('大人用歯ブラシ', known), true); // 候補が既存を含む
    assert.equal(isKnownOcrItem('補聴器の電池', known), false);
    assert.equal(isKnownOcrItem('x', known), false); // 短すぎる
});

// ---------- guessQuantity ----------

test('guessQuantity: 数量表現を抽出', () => {
    assert.equal(guessQuantity('肌着 3枚'), 3);
    assert.equal(guessQuantity('タオル２枚'), 2); // 全角数字はNFKCで半角に
    assert.equal(guessQuantity('お薬 1週間分'), 1);
    assert.equal(guessQuantity('靴下'), 1); // 数量なし
    assert.equal(guessQuantity(''), 1);
});

test('guessQuantity: 幅指定は上限を採用し、99が上限', () => {
    assert.equal(guessQuantity('肌着 2〜3枚'), 3);
    assert.equal(guessQuantity('パッド 2、3枚'), 3);
    assert.equal(guessQuantity('マスク 150枚'), 99);
});