// lib/ocr-match.js — OCR品目マッチングの純粋関数群(DOM・storage非依存)
// app.js(ブラウザ)とユニットテスト(node)の両方から import される。
//
// 設計方針:
// - 旧実装は部分文字列一致のみで、OCRの表記揺れ(濁点・送り仮名・文字欠け)に弱かった。
// - ここでは文字2グラム(bigram)のDice係数による「あいまい一致」をスコアリングして使う。
// - カテゴリ推定は「カタログ(data.jsonの項目)一致 > ヒント語一致 > others」の順。
//   カタログ一致は強い証拠、ヒント語はカタログに無い品目だけの弱い証拠として扱う。

export const OCR_CATEGORY_HINTS = {
    clothing: ['着替', '衣類', '服', '肌着', '下着', '靴下', 'パジャマ', '寝間着', '上着', '羽織', 'カーディガン', '室内履き', 'スリッパ'],
    hygiene: ['タオル', '歯ブラシ', 'コップ', '入れ歯', '洗浄', 'おむつ', 'パッド', 'おしりふき', '清拭', 'シャンプー', '石けん', 'ティッシュ', '袋'],
    medical: ['薬', 'お薬', '服薬', '処方', '目薬', '軟膏', '湿布', 'とろみ', '眼鏡', '補聴器', '電池'],
    documents: ['保険証', '診察券', '認定証', '印鑑', '連絡先', '書類', '同意書', '利用票', '介護保険'],
    others: ['マスク', '水筒', '飲み物', '連絡帳', 'カード', '本', 'ラジオ', '携帯', '充電器', '小銭', '財布'],
};

// ひらがな→カタカナ統一(OCR・入力の揺れ対策)。0x3041-0x3096 を +0x60 で変換。
function kanaToKatakana(text) {
    let out = '';
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code >= 0x3041 && code <= 0x3096) {
            out += String.fromCodePoint(code + 0x60);
        } else {
            out += ch;
        }
    }
    return out;
}

// OCRテキストの正規化。NFKCで全角英数→半角・異体字統一、小文字化、
// ひらがな→カタカナ統一、区切り・装飾記号を除去。
export function normalizeOcrText(text) {
    return kanaToKatakana(
        (text || '')
            .normalize('NFKC')
            .toLowerCase()
    ).replace(/[\s・、。,.．／/()（）[\]【】「」『』:：;；\-ー〜~※★☆●○◎]+/g, '');
}

// 濁点・半濁点の脱落(歯ブラシ→歯ぶらし)はOCRで頻出する表記揺れ。
// 清音に畳み込むことで「歯ぶらし」≒「歯ブラシ」を吸収する。ひらがな・カタカナ両対応。
const DAKUTEN_STRIP = {
    'が': 'か', 'ぎ': 'き', 'ぐ': 'く', 'げ': 'け', 'ご': 'こ',
    'ざ': 'さ', 'じ': 'し', 'ず': 'す', 'ぜ': 'せ', 'ぞ': 'そ',
    'だ': 'た', 'ぢ': 'ち', 'づ': 'つ', 'で': 'て', 'ど': 'と',
    'ば': 'は', 'び': 'ひ', 'ぶ': 'ふ', 'べ': 'へ', 'ぼ': 'ほ',
    'ぱ': 'は', 'ぴ': 'ひ', 'ぷ': 'ふ', 'ぺ': 'へ', 'ぽ': 'ほ',
    'ガ': 'カ', 'ギ': 'キ', 'グ': 'ク', 'ゲ': 'ケ', 'ゴ': 'コ',
    'ザ': 'サ', 'ジ': 'シ', 'ズ': 'ス', 'ゼ': 'セ', 'ゾ': 'ソ',
    'ダ': 'タ', 'ヂ': 'チ', 'ヅ': 'ツ', 'デ': 'テ', 'ド': 'ト',
    'バ': 'ハ', 'ビ': 'ヒ', 'ブ': 'フ', 'ベ': 'ヘ', 'ボ': 'ホ',
    'パ': 'ハ', 'ピ': 'ヒ', 'プ': 'フ', 'ペ': 'ヘ', 'ポ': 'ホ',
};

function stripDakuten(text) {
    let out = '';
    for (const ch of text) out += DAKUTEN_STRIP[ch] || ch;
    return out;
}

// 小文字カナの揺れを畳み込む(OCR誤読の頻出パターン)。
// 長音記号(ー〜~等)は normalizeOcrText がすでに除去するため、ここでは小文字母音を除去する。
// 例: 「ティッシュ」(テ+ィ+ッ+シ+ュ) と「テッシュ」(テ+ッ+シ+ュ) は、
//     ィ を除去すると両者とも「テッシュ」となり完全一致する。
// 拗音(ャュョ)は音の変化が大きく過剰マッチングの恐れがあるため除去しない。
// similarity() で素の文字列とこの畳み込み後の両方を比較し、高い方を採用する。
const SMALL_VOWEL_KANA = new Set(['ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ヵ', 'ヶ']);

export function foldVariants(text) {
    let out = '';
    for (const ch of Array.from(text)) {
        if (!SMALL_VOWEL_KANA.has(ch)) out += ch;
    }
    return out;
}

// 文字2グラムの多重集合(Map)。CJKは文字単位で意味を持つためbigramが有効。
// 1文字のときはその文字自体をトークンとして扱う。
function toBigrams(text) {
    const chars = Array.from(text); // サロゲートペア対応
    const map = new Map();
    if (chars.length === 1) {
        map.set(chars[0], 1);
        return map;
    }
    for (let i = 0; i < chars.length - 1; i += 1) {
        const g = chars[i] + chars[i + 1];
        map.set(g, (map.get(g) || 0) + 1);
    }
    return map;
}

// 正規化済み文字列同士のbigram Dice係数(0..1)。
function bigramDice(x, y) {
    const ga = toBigrams(x);
    const gb = toBigrams(y);
    let sizeA = 0;
    let sizeB = 0;
    for (const v of ga.values()) sizeA += v;
    for (const v of gb.values()) sizeB += v;
    if (sizeA === 0 || sizeB === 0) return 0;
    let overlap = 0;
    for (const [g, n] of ga) {
        const m = gb.get(g);
        if (m) overlap += Math.min(n, m);
    }
    return (2 * overlap) / (sizeA + sizeB);
}

// 正規化済み文字列同士の類似度(0..1)。空同士・空との比較は0。
// 素の文字列・濁点除去後・小文字カナ畳み込み後の各表現でDice係数を計算し、高い方を採用する。
// OCRは濁点脱落と小文字⇔大文字の誤読が頻出するため、複数の正規化表現を横断して比較する。
export function similarity(a, b) {
    const x = normalizeOcrText(a);
    const y = normalizeOcrText(b);
    if (!x || !y) return 0;
    if (x === y) return 1;

    // 比較に使う表現の候補群(重複は除く)
    const variantsOf = (s) => {
        const set = new Set([s]);
        const dak = stripDakuten(s);
        if (dak !== s) set.add(dak);
        const fold = foldVariants(s);
        if (fold !== s && fold) set.add(fold);
        const dakFold = foldVariants(dak);
        if (dakFold !== s && dakFold) set.add(dakFold);
        return Array.from(set);
    };

    let best = 0;
    for (const vx of variantsOf(x)) {
        for (const vy of variantsOf(y)) {
            if (vx === vy) return 1;
            best = Math.max(best, bigramDice(vx, vy));
        }
    }
    return best;
}

// 品目名を「・」「/」でトークン分割する(「歯ブラシ・コップ」→「歯ブラシ」「コップ」)。
// 複合語のまま照合すると候補が埋もれて類似度が薄まるため、トークン単位でも比較する。
function splitItemTokens(name) {
    return String(name || '')
        .split(/[・/／]+/)
        .map((t) => normalizeOcrText(t))
        .filter(Boolean);
}

// 候補キー1つとカタログトークン1つの照合スコア(高いほど強い証拠)。
function matchScore(itemKey, normalized) {
    if (itemKey === normalized) return 4; // 完全一致
    if (itemKey.length >= 2 && normalized.length >= 2 && (itemKey.includes(normalized) || normalized.includes(itemKey))) {
        // 包含一致。共通部分(短い方)が長いほど信頼度を上げる
        return 2 + Math.min(itemKey.length, normalized.length) / 20;
    }
    if (Math.min(itemKey.length, normalized.length) >= 2) {
        // あいまい一致(OCRの表記揺れ・送り仮名違い対策)
        const sim = similarity(itemKey, normalized);
        if (sim >= 0.75) return 1.5 * sim;
    }
    return 0;
}

// 候補名 → カテゴリID推定。何もヒットしなければ 'others'。
// categories: data.json の categories 配列、hints: ヒント語辞書(省略時は既定)。
export function inferOcrCategory(name, categories, hints = OCR_CATEGORY_HINTS) {
    const normalized = normalizeOcrText(name);
    if (!normalized) return 'others';

    let bestId = null;
    let bestScore = 0;
    const consider = (categoryId, score) => {
        if (score > bestScore) {
            bestScore = score;
            bestId = categoryId;
        }
    };

    // 1) カタログ項目との照合(最も強い証拠)。複合語はトークン分割して比較する。
    for (const cat of categories || []) {
        for (const item of cat.items || []) {
            const tokens = splitItemTokens(item.name);
            for (const itemKey of tokens) {
                consider(cat.id, matchScore(itemKey, normalized));
            }
        }
    }
    if (bestId) return bestId;

    // 2) ヒント語(カタログ外の名前だけ)。
    //    まず包含一致を定義順で探す(旧実装と同じ挙動)。
    for (const [categoryId, words] of Object.entries(hints || {})) {
        for (const hint of words) {
            const hintKey = normalizeOcrText(hint);
            if (hintKey && normalized.includes(hintKey)) return categoryId;
        }
    }
    //    包含で拾えない表記揺れ(濁点落ち・小文字カナ・漢字のカナ誤読)はあいまい一致で補う。
    //    閾値0.65は「4文字以上の語で1文字だけの誤読」(Dice=(n-2)/(n-1)、n=4で0.667)を拾い、
    //    3文字語の1文字置換(Dice=0.5)は拾わない。ヒント語は弱い証拠なので誤マッチング余地は小さい。
    for (const [categoryId, words] of Object.entries(hints || {})) {
        for (const hint of words) {
            const hintKey = normalizeOcrText(hint);
            if (hintKey.length >= 4 && normalized.length >= 4 && similarity(hintKey, normalized) >= 0.65) {
                return categoryId;
            }
        }
    }
    return 'others';
}

// 既存リスト(カタログ+施設テンプレート+個人追加)に同じ品目があるか。
// 部分文字列一致に加え、短い候補はbigram類似度0.8以上であいまい判定する。
export function isKnownOcrItem(name, knownNames) {
    const candidateKey = normalizeOcrText(name);
    if (candidateKey.length < 2) return false;
    for (const known of knownNames || []) {
        const knownKey = normalizeOcrText(known);
        if (knownKey.length < 2) continue;
        if (knownKey.includes(candidateKey)) return true;
        if (candidateKey.length >= 4 && candidateKey.includes(knownKey)) return true;
        if (candidateKey.length >= 3 && similarity(knownKey, candidateKey) >= 0.8) return true;
    }
    return false;
}

// 品名から数量を推定。「3枚」「2〜3枚」「2、3枚」「１週間分」など。取れないときは1。
// 幅のある指定は上限側を採用(介護準備は「日数分+予備」が基本のため)。上限99。
const QTY_UNITS = '枚|個|本|組|足|箱|着|セット|日分|泊分|週間分';
// 3桁まで捕捉する(「150枚」の"50枚"への部分一致防止)。上限はguessQuantity側で99に丸める。
const QTY_RANGE_RE = new RegExp(`(\\d{1,3})\\s*[〜~－\\-ー・、,]+\\s*(\\d{1,3})\\s*(?:${QTY_UNITS})`);
const QTY_SINGLE_RE = new RegExp(`(\\d{1,3})\\s*(?:${QTY_UNITS})`);

export function guessQuantity(name) {
    const normalized = (name || '').normalize('NFKC');
    const range = normalized.match(QTY_RANGE_RE);
    if (range) {
        const hi = Math.max(Number(range[1]), Number(range[2]));
        return Number.isFinite(hi) && hi > 0 ? Math.min(hi, 99) : 1;
    }
    const single = normalized.match(QTY_SINGLE_RE);
    if (!single) return 1;
    const qty = Number(single[1]);
    return Number.isFinite(qty) && qty > 0 ? Math.min(qty, 99) : 1;
}