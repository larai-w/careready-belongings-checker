// app.js — CareReady メインロジック
import { initStorage, getState, setState, removeState } from './storage.js';

// APIのURL。空文字のままなら同梱の data.json を使用する。
// 例: const API_URL = 'https://veai.jp/api/checklist';
const API_URL = '';

// バックエンドAPIベースURL (B-3 施設テンプレ)
const API_BASE = 'https://6r6n0fjn4d.execute-api.ap-northeast-1.amazonaws.com';
// Web Push の公開鍵(公開してよい)。秘密鍵は AWS Secrets Manager のみ。
const VAPID_PUBLIC_KEY = 'BLTVm2Q6Ps4Doy4Z1hqoYDOBTY6jm26mjrv2kUrZJZkH3qBPxIeynFvH4EnIGLkciHsoiQdJzYBBH53EFaxMVDc';

const FETCH_TIMEOUT_MS = 8000;
const OCR_TIMEOUT_MS = 30000;
const OCR_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const OCR_MAX_IMAGE_SIDE = 1800;
const OCR_JPEG_QUALITY = 0.85;

const CONTAINERS = [
    { id: 'none', name: '未指定 📦' },
    { id: 'box1', name: '箱 1' },
    { id: 'box2', name: '箱 2' },
    { id: 'box3', name: '箱 3' },
    { id: 'box4', name: '箱 4' },
    { id: 'bag', name: '手提げバッグ' },
];

let appData = null;
let currentSubtype = '';
let viewMode = 'category';   // 'category' | 'container'
let returnMode = false;       // 帰宅チェックモード
let returnCheckOpen = false;  // おかえりの忘れ物チェックは任意で開く
let modalQty = 1;
let pendingCategoryId = null;
let pendingImportData = null;
let toastTimer = null;
let ocrCandidates = [];

// 施設コードモーダル状態
let fcRedeemState = null;   // null | { name, items, overrides, facilityName, code }

const $ = (id) => document.getElementById(id);

// ---------- State helpers ----------

function getCustomItems() {
    return getState('customItems', []);
}

function getCustomContainers() {
    const list = getState('customContainers', []);
    return Array.isArray(list) ? list : [];
}

// 固定コンテナ + ユーザー追加コンテナ をまとめて返す
function getAllContainers() {
    return [...CONTAINERS, ...getCustomContainers()];
}

function isCustomContainer(id) {
    return typeof id === 'string' && id.startsWith('cc_');
}

function getContainerName(id) {
    const names = getState('containerNames', {});
    const def = getAllContainers().find((c) => c.id === id);
    return names[id] || (def ? def.name : id);
}

// ---------- Condition helpers ----------

function getConditionState() {
    return getState('conditions', {});
}

function isConditionActive(conditionId) {
    if (!appData || !appData.conditions) return true;
    const cond = appData.conditions.find((c) => c.id === conditionId);
    if (!cond) return true;
    const saved = getConditionState();
    return saved[conditionId] !== undefined ? saved[conditionId] : cond.default;
}

// アイテムが現在の条件設定で表示すべきか判定
function isItemVisible(item) {
    if (!item.condition) return true;
    return isConditionActive(item.condition);
}

// ---------- Facility template helpers ----------

function getFacilityTemplate() {
    return getState('facilityTemplate', null);
}

// 施設テンプレのhide対象IDセットを返す
function getFacilityHideSet() {
    const tpl = getFacilityTemplate();
    if (!tpl || !tpl.overrides || !Array.isArray(tpl.overrides.hide)) return new Set();
    return new Set(tpl.overrides.hide);
}

// 施設テンプレのアイテムをカテゴリIDごとにまとめて返す
// facilityItems はカテゴリIDをキーとした配列オブジェクト
function getFacilityItemsByCategory() {
    const tpl = getFacilityTemplate();
    if (!tpl || !Array.isArray(tpl.items)) return {};
    const result = {};
    tpl.items.forEach((item) => {
        const catId = item.categoryId || '__facility__';
        if (!result[catId]) result[catId] = [];
        result[catId].push({ ...item, isFacility: true });
    });
    return result;
}

// 施設テンプレバナーを更新する
function updateFacilityBanner() {
    const tpl = getFacilityTemplate();
    const banner = $('facility-banner');
    const noteBanner = $('facility-note-banner');

    if (tpl) {
        const nameEl = $('facility-banner-name');
        nameEl.textContent = tpl.name + (tpl.facilityName ? ' — ' + tpl.facilityName : '');
        banner.classList.remove('hidden');
        banner.classList.add('flex');

        if (tpl.overrides && tpl.overrides.note) {
            const noteText = $('facility-note-text');
            noteText.textContent = tpl.overrides.note;
            noteBanner.classList.remove('hidden');
        } else {
            noteBanner.classList.add('hidden');
        }
    } else {
        banner.classList.add('hidden');
        banner.classList.remove('flex');
        noteBanner.classList.add('hidden');
    }
}

// ---------- Data loading ----------

async function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function isValidData(data) {
    return (
        data &&
        Array.isArray(data.locations) &&
        data.locations.length > 0 &&
        Array.isArray(data.categories)
    );
}

async function loadChecklist() {
    if (API_URL) {
        try {
            const data = await fetchWithTimeout(API_URL);
            if (isValidData(data)) {
                setState('cachedData', data);
                return { data, source: 'api' };
            }
            console.error('APIレスポンスの形式が不正です');
        } catch (e) {
            console.warn('API取得に失敗:', e);
        }
        const cached = getState('cachedData', null);
        if (isValidData(cached)) return { data: cached, source: 'cache' };
    }
    const data = await fetchWithTimeout('./data.json');
    if (!isValidData(data)) throw new Error('data.json の形式が不正です');
    return { data, source: 'bundled' };
}

function showDataBanner(source) {
    const banner = $('data-banner');
    if (source === 'cache') {
        banner.textContent = '⚠️ サーバーに接続できないため、前回取得したデータを表示しています';
        banner.className =
            'text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-4 text-center';
    } else if (source === 'bundled' && API_URL) {
        banner.textContent = '⚠️ サーバーに接続できないため、標準リストを表示しています';
        banner.className =
            'text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-4 text-center';
    } else {
        banner.textContent = '';
        banner.className = 'hidden';
    }
}

async function startApp() {
    await initStorage();
    restoreTheme();
    checkImportParam();
    try {
        const { data, source } = await loadChecklist();
        appData = data;
        showDataBanner(source);
        currentSubtype = appData.locations[0].id;
        updateFacilityBanner();
        renderConditionToggles();
        renderTabs();
        // ① 最後に使ったビューで開く(初回はリスト)
        switchViewMode(getState('viewMode', 'category'));
        renderPersonName();
        renderMemo();
        renderReminder();
        renderPushToggle();
        renderPushPrompt();
        // ⑤ 開いたときの寄り添う挨拶(名前があれば呼びかける)
        setTimeout(() => {
            const n = getPersonName();
            showToast(`${n ? n + 'さん、' : ''}きょうも いっしょに準備していきましょう！`, 3500);
        }, 400);
        // ?fc= パラメータ処理 (data読込後)
        checkFacilityCodeParam();
    } catch (e) {
        console.error('データの取得に失敗しました:', e);
        const tabs = $('location-tabs');
        tabs.textContent = '';
        const msg = document.createElement('p');
        msg.className = 'text-red-400 text-sm';
        msg.textContent = 'データの読み込みに失敗しました。';
        const retry = document.createElement('button');
        retry.className = 'ml-2 text-teal-400 underline text-sm';
        retry.textContent = '再試行';
        retry.addEventListener('click', () => {
            tabs.textContent = '読み込み中...';
            startApp();
        });
        msg.appendChild(retry);
        tabs.appendChild(msg);
    }
}

// ---------- Import / Export ----------

function encodeShareData(data) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}

function decodeShareData(str) {
    return JSON.parse(decodeURIComponent(escape(atob(str))));
}

function checkImportParam() {
    const t = new URLSearchParams(window.location.search).get('t');
    if (!t) return;
    try {
        const data = decodeShareData(t);
        const hasItems = Array.isArray(data.customItems) && data.customItems.length > 0;
        const hasNames = data.containerNames && Object.keys(data.containerNames).length > 0;
        if (hasItems || hasNames) {
            pendingImportData = data;
            const banner = $('import-banner');
            banner.classList.remove('hidden');
            banner.classList.add('flex');
        }
    } catch (e) {
        console.warn('インポートデータの解析に失敗:', e);
    }
}

function handleImportOk() {
    if (!pendingImportData) return;

    if (Array.isArray(pendingImportData.customItems) && pendingImportData.customItems.length > 0) {
        const existing = getCustomItems();
        const existingIds = new Set(existing.map((i) => i.id));
        const toAdd = pendingImportData.customItems.filter((i) => !existingIds.has(i.id));
        setState('customItems', [...existing, ...toAdd]);
    }
    if (pendingImportData.containerNames) {
        const names = getState('containerNames', {});
        setState('containerNames', { ...names, ...pendingImportData.containerNames });
    }
    if (Array.isArray(pendingImportData.customContainers) && pendingImportData.customContainers.length > 0) {
        const existing = getCustomContainers();
        const existingIds = new Set(existing.map((c) => c.id));
        const toAdd = pendingImportData.customContainers.filter((c) => c && c.id && !existingIds.has(c.id));
        if (toAdd.length > 0) setState('customContainers', [...existing, ...toAdd]);
    }

    pendingImportData = null;
    $('import-banner').classList.add('hidden');
    $('import-banner').classList.remove('flex');
    window.history.replaceState({}, '', window.location.pathname);

    if (appData) renderChecklist();
    showToast('リストを取り込みました ✅');
}

function dismissImport() {
    pendingImportData = null;
    $('import-banner').classList.add('hidden');
    $('import-banner').classList.remove('flex');
    window.history.replaceState({}, '', window.location.pathname);
}

// ---------- 施設コード取込 (B-3) ----------

async function redeemFacilityCode(code) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${API_BASE}/v1/templates/redeem`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code.toUpperCase() }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        const json = await res.json();
        if (!res.ok) {
            throw new Error(json.error || `HTTP ${res.status}`);
        }
        return json;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

// URLパラメータ ?fc= の自動取込
function checkFacilityCodeParam() {
    const fc = new URLSearchParams(window.location.search).get('fc');
    if (!fc) return;
    // パラメータをすぐ除去
    window.history.replaceState({}, '', window.location.pathname);
    // オフラインチェック
    if (!navigator.onLine) {
        showToast('オフラインのため施設コードを取り込めません');
        return;
    }
    redeemFacilityCode(fc).then((tpl) => {
        const saved = {
            code: fc.toUpperCase(),
            name: tpl.name,
            items: tpl.items || [],
            overrides: tpl.overrides || {},
            facilityName: tpl.facilityName || '',
            shareCode: tpl.shareCode || fc.toUpperCase(),
            redeemedAt: new Date().toISOString(),
        };
        setState('facilityTemplate', saved);
        updateFacilityBanner();
        renderChecklist();
        showToast(`🏥 施設テンプレ「${tpl.name}」を取り込みました`);
    }).catch((e) => {
        const msg = e.name === 'AbortError' ? 'タイムアウトしました。再試行してください。' : '施設コードの取り込みに失敗しました。コードをお確かめの上、再試行してください。';
        showToast(msg, 4000);
    });
}

// 施設コードモーダルを開く
function openFcModal() {
    fcRedeemState = null;
    const input = $('fc-code-input');
    input.value = '';
    $('fc-confirm-area').classList.add('hidden');
    $('fc-error-msg').classList.add('hidden');
    $('fc-modal-submit').textContent = '受け取る';
    $('fc-modal').classList.remove('hidden');
    $('fc-modal').classList.add('flex');
    setTimeout(() => input.focus(), 50);
}

function closeFcModal() {
    fcRedeemState = null;
    $('fc-modal').classList.add('hidden');
    $('fc-modal').classList.remove('flex');
}

async function handleFcModalSubmit() {
    const input = $('fc-code-input');
    const code = input.value.trim().toUpperCase();
    const errorEl = $('fc-error-msg');
    const confirmArea = $('fc-confirm-area');

    errorEl.classList.add('hidden');

    // 確認フェーズ: fcRedeemStateがあればそのまま保存
    if (fcRedeemState) {
        const saved = {
            code: fcRedeemState.code,
            name: fcRedeemState.name,
            items: fcRedeemState.items || [],
            overrides: fcRedeemState.overrides || {},
            facilityName: fcRedeemState.facilityName || '',
            shareCode: fcRedeemState.shareCode || fcRedeemState.code,
            redeemedAt: new Date().toISOString(),
        };
        setState('facilityTemplate', saved);
        closeFcModal();
        updateFacilityBanner();
        renderChecklist();
        showToast(`🏥 施設テンプレ「${saved.name}」を取り込みました`);
        return;
    }

    if (code.length < 1) {
        errorEl.textContent = '施設コードを入力してください';
        errorEl.classList.remove('hidden');
        return;
    }

    if (!navigator.onLine) {
        errorEl.textContent = 'オフラインのため取り込めません。オンラインで再試行してください。';
        errorEl.classList.remove('hidden');
        return;
    }

    const submitBtn = $('fc-modal-submit');
    submitBtn.textContent = '確認中…';
    submitBtn.disabled = true;

    try {
        const tpl = await redeemFacilityCode(code);
        fcRedeemState = {
            code,
            name: tpl.name,
            items: tpl.items || [],
            overrides: tpl.overrides || {},
            facilityName: tpl.facilityName || '',
            shareCode: tpl.shareCode || code,
        };
        // 確認UI表示
        $('fc-confirm-name').textContent = tpl.name;
        $('fc-confirm-facility').textContent = tpl.facilityName ? '施設: ' + tpl.facilityName : '';
        confirmArea.classList.remove('hidden');
        submitBtn.textContent = '取り込む';
        submitBtn.disabled = false;
        input.disabled = true;
    } catch (e) {
        const msg = e.name === 'AbortError' ? 'タイムアウトしました。再試行してください。' : (e.message || '取り込みに失敗しました');
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
        submitBtn.textContent = '受け取る';
        submitBtn.disabled = false;
    }
}

function revokeFacilityTemplate() {
    if (!confirm('施設テンプレを解除しますか？\n標準リストに戻ります。')) return;
    removeState('facilityTemplate');
    updateFacilityBanner();
    renderChecklist();
    showToast('施設テンプレを解除しました');
}

// ---------- OCR取込 ----------

const OCR_CATEGORY_HINTS = {
    clothing: ['着替', '衣類', '服', '肌着', '下着', '靴下', 'パジャマ', '寝間着', '上着', '羽織', 'カーディガン', '室内履き', 'スリッパ'],
    hygiene: ['タオル', '歯ブラシ', 'コップ', '入れ歯', '洗浄', 'おむつ', 'パッド', 'おしりふき', '清拭', 'シャンプー', '石けん', 'ティッシュ', '袋'],
    medical: ['薬', 'お薬', '服薬', '処方', '目薬', '軟膏', '湿布', 'とろみ', '眼鏡', '補聴器', '電池'],
    documents: ['保険証', '診察券', '認定証', '印鑑', '連絡先', '書類', '同意書', '利用票', '介護保険'],
    others: ['マスク', '水筒', '飲み物', '連絡帳', 'カード', '本', 'ラジオ', '携帯', '充電器', '小銭', '財布'],
};

function normalizeOcrText(text) {
    return (text || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s・、。,.／/()（）[\]【】「」『』:：\-ー〜~]+/g, '');
}

function getCategoryName(categoryId) {
    const cat = appData && appData.categories.find((c) => c.id === categoryId);
    return cat ? cat.name : '🎒 その他';
}

function inferOcrCategory(name) {
    const normalized = normalizeOcrText(name);
    if (!appData) return 'others';

    for (const cat of appData.categories) {
        for (const item of cat.items || []) {
            const itemKey = normalizeOcrText(item.name);
            if (itemKey && normalized.length >= 3 && (itemKey.includes(normalized) || normalized.includes(itemKey))) {
                return cat.id;
            }
        }
    }

    for (const [categoryId, hints] of Object.entries(OCR_CATEGORY_HINTS)) {
        if (hints.some((hint) => normalized.includes(normalizeOcrText(hint)))) {
            return categoryId;
        }
    }
    return 'others';
}

function getKnownItemNames() {
    const names = [];
    if (appData) {
        appData.categories.forEach((cat) => {
            (cat.items || []).forEach((item) => names.push(item.name));
        });
    }
    const facilityTemplate = getFacilityTemplate();
    if (facilityTemplate && Array.isArray(facilityTemplate.items)) {
        facilityTemplate.items.forEach((item) => names.push(item.name));
    }
    getCustomItems().forEach((item) => names.push(item.name));
    return names;
}

function isKnownOcrItem(name) {
    const candidateKey = normalizeOcrText(name);
    if (candidateKey.length < 2) return false;
    return getKnownItemNames().some((knownName) => {
        const knownKey = normalizeOcrText(knownName);
        return knownKey.length >= 2 && (
            knownKey.includes(candidateKey) ||
            (candidateKey.length >= 4 && candidateKey.includes(knownKey))
        );
    });
}

function guessQuantity(name) {
    const normalized = (name || '').normalize('NFKC');
    const match = normalized.match(/(\d{1,2})\s*(枚|個|本|組|足|箱|日分|セット)/);
    if (!match) return 1;
    const qty = Number(match[1]);
    return Number.isFinite(qty) && qty > 0 ? Math.min(qty, 99) : 1;
}

function setOcrError(message) {
    const errorEl = $('ocr-error-msg');
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
}

function clearOcrError() {
    const errorEl = $('ocr-error-msg');
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
}

function updateOcrImportButton() {
    const selected = ocrCandidates.filter((candidate) => candidate.checked && candidate.name.trim());
    const importBtn = $('ocr-import-btn');
    importBtn.disabled = selected.length === 0;
    importBtn.textContent = selected.length > 0 ? `${selected.length}件を追加する` : '追加する';
}

function resetOcrModal() {
    ocrCandidates = [];
    $('ocr-file-input').value = '';
    $('ocr-status').textContent = '';
    $('ocr-candidate-list').textContent = '';
    $('ocr-results').classList.add('hidden');
    $('ocr-start-btn').classList.remove('hidden');
    $('ocr-start-btn').disabled = false;
    $('ocr-start-btn').textContent = '読み取る';
    $('ocr-import-btn').classList.add('hidden');
    $('ocr-import-btn').disabled = true;
    clearOcrError();
}

function openOcrModal() {
    resetOcrModal();
    $('ocr-modal').classList.remove('hidden');
    $('ocr-modal').classList.add('flex');
}

function closeOcrModal() {
    $('ocr-modal').classList.add('hidden');
    $('ocr-modal').classList.remove('flex');
}

function loadImageElement(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('写真を読み込めませんでした。JPEGまたはPNGで試してください。'));
        };
        img.src = url;
    });
}

function canvasToJpegBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) reject(new Error('写真の変換に失敗しました。'));
            else resolve(blob);
        }, 'image/jpeg', quality);
    });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            resolve(result.slice(result.indexOf(',') + 1));
        };
        reader.onerror = () => reject(new Error('写真を読み込めませんでした。'));
        reader.readAsDataURL(blob);
    });
}

async function prepareOcrImage(file) {
    if (!file || !file.type.startsWith('image/')) {
        throw new Error('写真ファイルを選択してください。');
    }

    const img = await loadImageElement(file);
    const scale = Math.min(1, OCR_MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    let blob = await canvasToJpegBlob(canvas, OCR_JPEG_QUALITY);
    if (blob.size > OCR_MAX_UPLOAD_BYTES) {
        blob = await canvasToJpegBlob(canvas, 0.68);
    }
    if (blob.size > OCR_MAX_UPLOAD_BYTES) {
        throw new Error('写真が大きすぎます。少し離れて1枚に収めるか、余白を切り取ってください。');
    }
    return blobToBase64(blob);
}

async function requestOcrItems(imageBase64, mimeType) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
    try {
        const res = await fetch(`${API_BASE}/v1/ocr/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64, mimeType }),
            signal: controller.signal,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (res.status === 429) {
                throw new Error('今日の読み取り回数の上限に達しました。明日もう一度試すか、手入力で追加してください。');
            }
            if (res.status === 502 || res.status === 503) {
                throw new Error('読み取り機能を一時的に利用できません。写真の内容は保存されていません。時間を置いて再試行してください。');
            }
            throw new Error(json.error || `HTTP ${res.status}`);
        }
        return json;
    } finally {
        clearTimeout(timer);
    }
}

function renderOcrCandidates(items) {
    const list = $('ocr-candidate-list');
    list.textContent = '';

    ocrCandidates = (items || []).map((item, index) => {
        const name = String(item.name || '').trim().slice(0, 50);
        const duplicate = isKnownOcrItem(name);
        const categoryId = inferOcrCategory(name);
        return {
            id: `ocr_${Date.now()}_${index}`,
            name,
            confidence: item.confidence,
            categoryId,
            quantity: guessQuantity(name),
            checked: !duplicate,
            duplicate,
        };
    }).filter((candidate) => candidate.name);

    $('ocr-count').textContent = `${ocrCandidates.length}件`;
    $('ocr-results').classList.toggle('hidden', ocrCandidates.length === 0);
    $('ocr-start-btn').classList.add('hidden');
    $('ocr-import-btn').classList.remove('hidden');

    if (ocrCandidates.length === 0) {
        $('ocr-status').textContent = '追加候補を見つけられませんでした。明るい場所で、紙全体が写るように撮り直してください。';
        updateOcrImportButton();
        return;
    }

    $('ocr-status').textContent = '必要なものだけ選んで、名前やカテゴリーを確認してください。';

    ocrCandidates.forEach((candidate) => {
        const row = document.createElement('div');
        row.className = 'bg-gray-800/70 border border-gray-700 rounded-xl p-3 space-y-2';

        const top = document.createElement('div');
        top.className = 'flex items-center gap-2';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = candidate.checked;
        cb.className = 'w-5 h-5 accent-amber-500';
        cb.addEventListener('change', () => {
            candidate.checked = cb.checked;
            updateOcrImportButton();
        });

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = candidate.name;
        nameInput.maxLength = 50;
        nameInput.className = 'flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-amber-500';
        nameInput.addEventListener('input', () => {
            candidate.name = nameInput.value.trim();
            updateOcrImportButton();
        });

        top.append(cb, nameInput);
        row.appendChild(top);

        const bottom = document.createElement('div');
        bottom.className = 'flex items-center gap-2';

        const select = document.createElement('select');
        select.className = 'flex-1 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-amber-500';
        appData.categories.forEach((cat) => {
            const opt = document.createElement('option');
            opt.value = cat.id;
            opt.textContent = cat.name;
            opt.selected = cat.id === candidate.categoryId;
            select.appendChild(opt);
        });
        select.addEventListener('change', () => {
            candidate.categoryId = select.value;
        });
        bottom.appendChild(select);

        if (candidate.duplicate) {
            const badge = document.createElement('span');
            badge.className = 'text-[10px] text-gray-500 border border-gray-700 rounded px-1.5 py-1';
            badge.textContent = '既存候補';
            bottom.appendChild(badge);
        } else if (candidate.confidence > 0) {
            const confidence = document.createElement('span');
            confidence.className = 'text-[10px] text-gray-500';
            confidence.textContent = `${Math.round(candidate.confidence)}%`;
            bottom.appendChild(confidence);
        }

        row.appendChild(bottom);
        list.appendChild(row);
    });

    updateOcrImportButton();
}

async function handleOcrStart() {
    clearOcrError();
    const file = $('ocr-file-input').files && $('ocr-file-input').files[0];
    if (!file) {
        setOcrError('写真を選択してください。');
        return;
    }
    if (!navigator.onLine) {
        setOcrError('オフラインのため読み取れません。オンラインで再試行してください。');
        return;
    }

    const startBtn = $('ocr-start-btn');
    startBtn.disabled = true;
    startBtn.textContent = '読み取り中…';
    $('ocr-status').textContent = '写真を読み取り用に調整しています。';

    try {
        const imageBase64 = await prepareOcrImage(file);
        $('ocr-status').textContent = '紙の文字を読み取っています。';
        const result = await requestOcrItems(imageBase64, 'image/jpeg');
        renderOcrCandidates(result.items || []);
    } catch (e) {
        const message = e.name === 'AbortError' ? '読み取りがタイムアウトしました。写真を小さくして再試行してください。' : (e.message || '読み取りに失敗しました。');
        setOcrError(message);
        startBtn.disabled = false;
        startBtn.textContent = '読み取る';
    }
}

function handleOcrImport() {
    const selected = ocrCandidates.filter((candidate) => candidate.checked && candidate.name.trim());
    if (selected.length === 0) {
        setOcrError('追加する候補を選択してください。');
        return;
    }

    const existing = getCustomItems();
    const now = Date.now();
    const imported = selected.map((candidate, index) => ({
        id: `custom_ocr_${now}_${index}_${Math.random().toString(36).slice(2, 7)}`,
        name: candidate.name.trim().slice(0, 50),
        categoryId: candidate.categoryId,
        categoryName: getCategoryName(candidate.categoryId),
        applicable_locations: [currentSubtype],
        quantity: candidate.quantity || 1,
        isCustom: true,
        source: 'ocr',
    }));

    setState('customItems', [...existing, ...imported]);
    closeOcrModal();
    renderChecklist();
    showToast(`${imported.length}件を追加しました`);
}

// ---------- 条件トグルUI ----------

function renderConditionToggles() {
    const wrap = $('condition-toggles');
    if (!appData || !Array.isArray(appData.conditions) || appData.conditions.length === 0) {
        wrap.classList.add('hidden');
        return;
    }
    wrap.textContent = '';
    wrap.classList.remove('hidden');

    const condLabel = document.createElement('span');
    condLabel.className = 'text-xs text-gray-500 shrink-0';
    condLabel.textContent = '条件:';
    wrap.appendChild(condLabel);

    const condState = getConditionState();
    appData.conditions.forEach((cond) => {
        const isOn = condState[cond.id] !== undefined ? condState[cond.id] : cond.default;

        const btn = document.createElement('button');
        btn.className = isOn
            ? 'flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border transition-colors bg-teal-500/20 text-teal-300 border-teal-500/40'
            : 'flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border transition-colors bg-gray-800 text-gray-500 border-gray-700 hover:border-gray-600';

        const indicator = document.createElement('span');
        indicator.textContent = isOn ? '●' : '○';
        indicator.className = isOn ? 'text-teal-400' : 'text-gray-600';

        const label = document.createElement('span');
        label.textContent = cond.name;

        btn.append(indicator, label);
        btn.setAttribute('data-condition-id', cond.id);
        btn.addEventListener('click', () => toggleCondition(cond.id));
        wrap.appendChild(btn);
    });
}

function toggleCondition(conditionId) {
    const condState = getConditionState();
    const cond = appData.conditions.find((c) => c.id === conditionId);
    const current = condState[conditionId] !== undefined ? condState[conditionId] : (cond ? cond.default : true);
    condState[conditionId] = !current;
    setState('conditions', condState);
    renderConditionToggles();
    renderChecklist();
}

function generateShareURL() {
    const data = {
        customItems: getCustomItems(),
        containerNames: getState('containerNames', {}),
        customContainers: getCustomContainers(),
    };
    const encoded = encodeShareData(data);
    const base = window.location.origin + window.location.pathname;
    return `${base}?t=${encoded}`;
}

async function handleShare() {
    const url = generateShareURL();
    if (navigator.share) {
        try {
            await navigator.share({ title: 'CareReady 持ち物チェッカー', text: 'CareReadyで持ち物リストを共有しています', url });
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
        }
    }
    try {
        await navigator.clipboard.writeText(url);
        showToast('URLをコピーしました 📋');
    } catch {
        showToast('URLのコピーに失敗しました。ブラウザのアドレスバーからコピーしてください。', 5000);
    }
}

// ---------- LINE Share ----------

// 共有用の読めるテキスト(持ち物 + メモ)
function buildListShareText() {
    const locName = (getAllLocations().find((l) => l.id === currentSubtype) || {}).name || '持ち物';
    const customItems = getCustomItems();
    const hideSet = getFacilityHideSet();
    const lines = [`${locName}の持ち物リスト`, ''];
    appData.categories.forEach((cat) => {
        const items = [];
        (cat.items || []).forEach((item) => {
            if ((item.applicable_locations || []).includes(currentSubtype) && !hideSet.has(item.id) && isItemVisible(item)) {
                items.push(item.name);
            }
        });
        customItems.forEach((item) => {
            if (item.categoryId === cat.id && (item.applicable_locations || []).includes(currentSubtype) && isItemVisible(item)) {
                items.push(item.name);
            }
        });
        if (items.length) {
            lines.push(cat.name);
            items.forEach((n) => lines.push(`・${n}`));
            lines.push('');
        }
    });
    const memo = (getState('memos', {})[currentSubtype] || '').trim();
    if (memo) lines.push('【メモ】', memo, '');
    return lines.join('\n');
}

function handleLineShare() {
    const url = generateShareURL();
    let body = buildListShareText();
    // LINE共有はURL長に上限があるため、長すぎる時はメモ+リンクに省略
    if ((body + url).length > 900) {
        const locName = (getAllLocations().find((l) => l.id === currentSubtype) || {}).name || '持ち物';
        const memo = (getState('memos', {})[currentSubtype] || '').trim();
        body = `${locName}の持ち物リスト\n` + (memo ? `【メモ】${memo}\n` : '');
    }
    const text = `${body}\n${url}`;
    window.open('https://line.me/R/share?text=' + encodeURIComponent(text), '_blank', 'noopener');
}

// ---------- ご意見フォーム(CareReadyバックエンドへ直接) ----------

function openFeedback() {
    $('feedback-message').value = '';
    $('feedback-contact').value = '';
    $('feedback-error').classList.add('hidden');
    $('feedback-modal').classList.remove('hidden');
    $('feedback-modal').classList.add('flex');
    setTimeout(() => $('feedback-message').focus(), 50);
}

function closeFeedback() {
    $('feedback-modal').classList.add('hidden');
    $('feedback-modal').classList.remove('flex');
}

// ---------- 予定のお知らせ(Web Push・任意) ----------

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
    return arr;
}

function isPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function renderPushToggle() {
    const sec = $('push-section');
    if (!sec) return;
    if (!isPushSupported()) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    const on = getState('pushEnabled', false);
    const btn = $('push-toggle');
    btn.textContent = on ? '🔔 予定のお知らせ：ON中（タップでオフ）' : '🔔 予定のお知らせ：オフ（タップでオンにする）';
    btn.className = on
        ? 'w-full flex items-center justify-center gap-2 text-sm font-bold text-white bg-pink-500 hover:bg-pink-600 rounded-xl px-5 py-2.5 transition-colors'
        : 'w-full flex items-center justify-center gap-2 text-sm font-bold text-pink-600 bg-pink-500/10 border border-pink-300 hover:bg-pink-500/20 rounded-xl px-5 py-2.5 transition-colors';
}

// 予定日つきのおでかけがあるのに通知OFFのとき、上部にそっと誘導(見つけやすさ対策)。
// ONにしたら消える。予定が無ければ出さない(文脈に沿う)。
function renderPushPrompt() {
    const el = $('push-prompt');
    if (!el) return;
    const hide = () => { el.classList.add('hidden'); el.classList.remove('flex'); };
    if (!isPushSupported() || getState('pushEnabled', false)) { hide(); return; }
    const hasDatedOuting = getSpecialOutings().some((o) => {
        const n = daysUntil(o.date);
        return n !== null && n >= 0;
    });
    if (!hasDatedOuting) { hide(); return; }
    el.classList.remove('hidden');
    el.classList.add('flex');
}

async function enablePush() {
    try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { showToast('通知が許可されませんでした'); return; }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        const res = await fetch(`${API_BASE}/v1/push/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON() }),
        });
        if (!res.ok) throw new Error('failed');
        setState('pushEnabled', true);
        showToast('予定のお知らせをONにしました 🔔');
    } catch (e) {
        showToast('お知らせをONにできませんでした');
    }
}

async function disablePush() {
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            await fetch(`${API_BASE}/v1/push/unsubscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: sub.endpoint }),
            }).catch(() => {});
            await sub.unsubscribe().catch(() => {});
        }
    } catch (e) { /* noop */ }
    setState('pushEnabled', false);
    showToast('予定のお知らせをOFFにしました');
}

async function handlePushToggle() {
    if (getState('pushEnabled', false)) await disablePush();
    else await enablePush();
    renderPushToggle();
    renderPushPrompt();
}

async function sendFeedback() {
    const message = $('feedback-message').value.trim();
    const err = $('feedback-error');
    if (!message) {
        err.textContent = 'メッセージを入力してください。';
        err.classList.remove('hidden');
        return;
    }
    const contact = $('feedback-contact').value.trim();
    const btn = $('feedback-send');
    btn.disabled = true;
    err.classList.add('hidden');
    try {
        const res = await fetch(`${API_BASE}/v1/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, contact }),
        });
        if (!res.ok) throw new Error('failed');
        closeFeedback();
        showToast('送信しました。ありがとうございます 🍀', 3500);
    } catch (e) {
        err.textContent = '送信に失敗しました。電波の良い所で もう一度お試しください。';
        err.classList.remove('hidden');
    } finally {
        btn.disabled = false;
    }
}

// ---------- Theme ----------

function applyTheme(isLight) {
    if (isLight) {
        document.body.classList.add('light');
        document.querySelector('meta[name="theme-color"]').setAttribute('content', '#faf6f0');
        $('theme-btn').textContent = '☀️';
    } else {
        document.body.classList.remove('light');
        document.querySelector('meta[name="theme-color"]').setAttribute('content', '#121824');
        $('theme-btn').textContent = '🌙';
    }
}

function handleThemeToggle() {
    const current = getState('theme', 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    setState('theme', next);
    applyTheme(next === 'light');
}

function restoreTheme() {
    const saved = getState('theme', 'light');
    applyTheme(saved === 'light');
}

// ---------- だれの準備？(任意・ローカル) ----------

function getPersonName() {
    return getState('personName', '').trim();
}

function renderPersonName() {
    const btn = $('person-btn');
    if (!btn) return;
    const name = getPersonName();
    btn.textContent = name ? `🍀 ${name}さんの おでかけ` : '🍀 だれの準備？';
}

function handlePersonName() {
    const input = prompt('だれの準備ですか？（お名前・ニックネーム）', getPersonName());
    if (input === null) return;
    const name = input.trim().slice(0, 20);
    if (name) setState('personName', name);
    else removeState('personName');
    renderPersonName();
}

// ---------- 行き先ごとのメモ ----------

function renderMemo() {
    const el = $('memo-input');
    if (!el) return;
    const memos = getState('memos', {});
    el.value = (currentSubtype && memos[currentSubtype]) || '';
}

function saveMemo() {
    if (!currentSubtype) return;
    const memos = getState('memos', {});
    const v = $('memo-input').value.slice(0, 500);
    if (v.trim()) memos[currentSubtype] = v;
    else delete memos[currentSubtype];
    setState('memos', memos);
}

// ---------- Modal ----------

function openModal(categoryId) {
    pendingCategoryId = categoryId;
    modalQty = 1;
    $('modal-qty-display').textContent = '1';
    $('modal-item-name').value = '';

    // カテゴリー選択肢を生成
    const catSelect = $('modal-category');
    catSelect.textContent = '';
    appData.categories.forEach((cat) => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = cat.name;
        opt.selected = cat.id === categoryId;
        catSelect.appendChild(opt);
    });

    // 行き先チェックボックスを生成。特別なおでかけ中は その行き先のみ既定でON
    const locWrap = $('modal-locations');
    locWrap.textContent = '';
    const special = isSpecialOuting(currentSubtype);
    getAllLocations().forEach((loc) => {
        const label = document.createElement('label');
        label.className =
            'flex items-center gap-1.5 text-sm text-gray-300 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 cursor-pointer hover:border-teal-500 transition-colors';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = loc.id;
        cb.checked = special ? loc.id === currentSubtype : true;
        cb.className = 'accent-teal-500';
        const span = document.createElement('span');
        span.textContent = loc.special ? `🎉 ${loc.name}` : loc.name;
        label.append(cb, span);
        locWrap.appendChild(label);
    });

    $('add-modal').classList.remove('hidden');
    $('add-modal').classList.add('flex');
    setTimeout(() => $('modal-item-name').focus(), 50);
}

function closeModal() {
    $('add-modal').classList.add('hidden');
    $('add-modal').classList.remove('flex');
}

function handleModalSave() {
    const name = $('modal-item-name').value.trim();
    if (!name) {
        $('modal-item-name').focus();
        $('modal-item-name').classList.add('border-red-500');
        setTimeout(() => $('modal-item-name').classList.remove('border-red-500'), 1500);
        return;
    }

    const categoryId = $('modal-category').value;
    const cat = appData.categories.find((c) => c.id === categoryId);

    const checkedLocs = [...$('modal-locations').querySelectorAll('input[type="checkbox"]:checked')].map(
        (cb) => cb.value
    );
    if (checkedLocs.length === 0) {
        showToast('行き先を1つ以上選択してください');
        return;
    }

    const id = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const items = getCustomItems();
    items.push({
        id,
        name,
        categoryId,
        categoryName: cat ? cat.name : 'カスタム',
        applicable_locations: checkedLocs,
        quantity: modalQty,
        isCustom: true,
    });
    setState('customItems', items);
    closeModal();
    renderChecklist();
    showToast(`「${name}」を追加しました`);
}

// ---------- Return Mode ----------

function switchReturnMode(enabled) {
    returnMode = enabled;
    if (enabled) returnCheckOpen = false;   // 入るたびに忘れ物チェックは畳んでおく
    // 帰宅モードは背景を「おうち」の暖色に
    document.body.classList.toggle('return-mode', enabled);

    const returnBtn = $('mode-return');
    const viewModeToggle = $('view-mode-toggle');
    const progressSection = $('progress-section');
    const progressBarWrap = $('progress-bar-wrap');
    const progressMsg = $('progress-msg');
    const readySection = $('ready-section');
    const memoSection = $('memo-section');
    const returnProgressSection = $('return-progress-section');

    // 準備モード専用UIの表示/非表示
    [progressSection, progressBarWrap, progressMsg, readySection, memoSection].forEach((el) => {
        el.classList.toggle('hidden', returnMode);
    });
    returnProgressSection.classList.toggle('hidden', !returnMode);
    // おかえり中でも「箱に詰める/持ち物リスト」を押せば おでかけ準備に戻れる(戻り方を分かりやすく)
    viewModeToggle.classList.remove('opacity-40', 'pointer-events-none');

    // 帰宅チェックボタン(小)のON/OFF表示。テキストはHTML側(🏠 帰宅チェック)を維持
    returnBtn.className = returnMode
        ? 'shrink-0 text-[11px] font-bold leading-tight bg-green-500 text-slate-900 rounded-xl px-3 transition-colors shadow'
        : 'shrink-0 text-[11px] font-bold leading-tight bg-gray-800 border border-gray-700 text-gray-400 hover:text-green-400 hover:border-green-500/60 rounded-xl px-3 transition-colors';

    if (returnMode) {
        renderMood();
        renderReturnWelcome();
        clearDiaryPhoto();
    }

    renderChecklist();
    applyReturnCheckVisibility();
}

// おかえりの「忘れ物チェック」の表示/非表示(任意で開く)
function applyReturnCheckVisibility() {
    const details = $('return-check-details');
    const container = $('checklist-container');
    const doneSection = $('return-done-section');
    const toggle = $('return-check-toggle');
    const open = returnMode && returnCheckOpen;
    if (details) details.classList.toggle('hidden', !open);
    // 帰宅後はまず一息。リスト本体と「確認できた!」は開いた時だけ表示
    if (container) container.classList.toggle('hidden', returnMode && !returnCheckOpen);
    if (doneSection) doneSection.classList.toggle('hidden', !open);
    if (toggle) toggle.textContent = returnCheckOpen
        ? '🔼 忘れ物チェックを閉じる'
        : '🔎 施設に忘れ物がないか確認する（任意）';
}

// ---------- Render ----------

function switchViewMode(mode) {
    viewMode = mode;
    setState('viewMode', mode);   // 次回はこのビューで開く
    // おかえり中に表示を押したら、おでかけ準備に戻す(1タップで戻れる)
    if (returnMode) switchReturnMode(false);
    const active =
        'flex-1 py-2.5 text-sm font-bold rounded-lg transition-all bg-teal-500 text-slate-900 shadow';
    const inactive =
        'flex-1 py-2.5 text-sm font-bold rounded-lg transition-all text-gray-400 hover:text-gray-200';
    $('mode-category').className = mode === 'category' ? active : inactive;
    $('mode-container').className = mode === 'container' ? active : inactive;
    renderChecklist();
}

// ---------- 特別なおでかけ(自由な行き先) ----------

function getSpecialOutings() {
    const s = getState('specialOutings', []);
    return Array.isArray(s) ? s : [];
}

function isSpecialOuting(id) {
    return typeof id === 'string' && id.startsWith('so_');
}

// プリセット + 特別なおでかけ
function getAllLocations() {
    const presets = appData ? appData.locations : [];
    const special = getSpecialOutings().map((o) => ({ id: o.id, name: o.name, special: true, date: o.date }));
    return [...presets, ...special];
}

// 予定日まであと何日か(null=日付なし)
function daysUntil(dateStr) {
    if (!dateStr) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(`${dateStr}T00:00:00`);
    if (isNaN(d)) return null;
    return Math.round((d - today) / 86400000);
}

function countdownLabel(dateStr) {
    const n = daysUntil(dateStr);
    if (n === null) return '';
    if (n > 1) return `あと${n}日`;
    if (n === 1) return 'あした！';
    if (n === 0) return 'きょう！';
    return '';
}

// 予定日が今日〜7日以内で一番近い特別なおでかけ
function getUpcomingOuting() {
    let best = null;
    getSpecialOutings().forEach((o) => {
        const n = daysUntil(o.date);
        if (n !== null && n >= 0 && n <= 7 && (!best || n < best.days)) {
            best = { id: o.id, name: o.name, days: n };
        }
    });
    return best;
}

// 開いた時のやさしいお知らせ(しつこくない: その日に閉じたら再表示しない)
function renderReminder() {
    const banner = $('reminder-banner');
    if (!banner) return;
    const hide = () => { banner.classList.add('hidden'); banner.classList.remove('flex'); };
    const today = new Date().toISOString().slice(0, 10);
    if (getState('reminderDismissed', '') === today) { hide(); return; }
    const up = getUpcomingOuting();
    if (!up) { hide(); return; }
    const when = up.days === 0 ? 'きょう' : up.days === 1 ? 'あした' : `あと${up.days}日`;
    $('reminder-text').textContent = `🎉 ${up.name} まで ${when}！そろそろ準備しませんか？`;
    banner.dataset.outingId = up.id;
    banner.classList.remove('hidden');
    banner.classList.add('flex');
}

function renderTabs() {
    const tabsContainer = $('location-tabs');
    tabsContainer.textContent = '';
    getAllLocations().forEach((loc) => {
        const isActive = currentSubtype === loc.id;
        const button = document.createElement('button');
        // 行き先は最初に1回選ぶだけ → コンパクトに。特別なおでかけはピンク系で区別
        button.className = `w-full py-1.5 px-2 rounded-lg text-sm font-bold leading-tight transition-all ${
            isActive
                ? (loc.special ? 'bg-pink-500 text-white shadow' : 'bg-teal-500 text-slate-900 shadow')
                : (loc.special
                    ? 'bg-pink-50 text-pink-700 border border-pink-200 hover:bg-pink-100'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 border border-gray-700')
        }`;

        const nameEl = document.createElement('span');
        nameEl.textContent = loc.special ? `🎉 ${loc.name}` : loc.name;
        button.appendChild(nameEl);

        const sub = loc.special ? countdownLabel(loc.date) : loc.sublabel;
        if (sub) {
            const subEl = document.createElement('span');
            subEl.className = 'text-[10px] font-normal opacity-80 ml-1';
            subEl.textContent = sub;
            button.appendChild(subEl);
        }

        button.addEventListener('click', () => {
            currentSubtype = loc.id;
            renderTabs();
            renderChecklist();
            renderMemo();
        });
        tabsContainer.appendChild(button);
    });

    // ＋ 特別なおでかけを追加
    const addBtn = document.createElement('button');
    addBtn.className = 'w-full py-1.5 px-2 rounded-lg text-sm font-bold text-pink-600 bg-pink-50 border border-dashed border-pink-300 hover:bg-pink-100 transition-colors';
    addBtn.textContent = '🎉 ＋ 特別なおでかけ';
    addBtn.addEventListener('click', openSpecialModal);
    tabsContainer.appendChild(addBtn);

    // 選択中が特別なおでかけなら削除リンク(2列ぶち抜き)
    if (isSpecialOuting(currentSubtype)) {
        const del = document.createElement('button');
        del.className = 'col-span-2 text-[11px] text-gray-400 hover:text-red-400 underline transition-colors';
        del.textContent = '🗑️ この特別なおでかけを削除';
        del.addEventListener('click', () => deleteSpecialOuting(currentSubtype));
        tabsContainer.appendChild(del);
    }
}

function openSpecialModal() {
    $('special-name-input').value = '';
    $('special-date-input').value = '';
    $('special-modal').classList.remove('hidden');
    $('special-modal').classList.add('flex');
    setTimeout(() => $('special-name-input').focus(), 50);
}

function closeSpecialModal() {
    $('special-modal').classList.add('hidden');
    $('special-modal').classList.remove('flex');
}

function saveSpecialOuting() {
    const name = $('special-name-input').value.trim().slice(0, 30);
    if (!name) { $('special-name-input').focus(); return; }
    const date = $('special-date-input').value || '';
    const id = `so_${Date.now()}`;
    setState('specialOutings', [...getSpecialOutings(), { id, name, date }]);
    currentSubtype = id;
    closeSpecialModal();
    renderTabs();
    renderChecklist();
    renderMemo();
    renderPushPrompt();
    showToast(`「${name}」を作りました 🎉`);
}

function deleteSpecialOuting(id) {
    const o = getSpecialOutings().find((s) => s.id === id);
    if (!o) return;
    if (!confirm(`「${o.name}」を削除しますか？\n（この特別なおでかけの持ち物メモも消えます）`)) return;
    setState('specialOutings', getSpecialOutings().filter((s) => s.id !== id));
    // この行き先だけのカスタムアイテムを削除
    const remaining = getCustomItems().filter((it) => {
        const locs = it.applicable_locations || [];
        return !(locs.length === 1 && locs[0] === id);
    });
    setState('customItems', remaining);
    if (currentSubtype === id) currentSubtype = appData.locations[0].id;
    renderTabs();
    renderChecklist();
    renderMemo();
    renderPushPrompt();
    showToast(`「${o.name}」を削除しました`);
}

function renderChecklist() {
    if (returnMode) {
        renderReturnChecklist();
    } else {
        renderPrepChecklist();
    }
}

function renderPrepChecklist() {
    const container = $('checklist-container');
    container.textContent = '';

    const checked = getState('checked', {});
    const containers = getState('containers', {});
    const customItems = getCustomItems();

    // 3層マージ: 施設テンプレのhideセットと追加アイテム
    const hideSet = getFacilityHideSet();
    const facilityItemsByCategory = getFacilityItemsByCategory();

    if (viewMode === 'category') {
        // 特別なおでかけは自由に持ち物を追加(プリセット無し)
        if (isSpecialOuting(currentSubtype)) {
            const addWrap = document.createElement('div');
            const addBtn = document.createElement('button');
            addBtn.className = 'w-full flex items-center justify-center gap-2 text-sm font-bold text-pink-600 bg-pink-50 border border-dashed border-pink-300 hover:bg-pink-100 rounded-2xl px-5 py-3 transition-colors';
            addBtn.textContent = '＋ 持ち物を追加';
            addBtn.addEventListener('click', () => openModal('others'));
            addWrap.appendChild(addBtn);
            container.appendChild(addWrap);
        }
        // 通常カテゴリを処理
        appData.categories.forEach((cat, catIdx) => {
            const officialItems = (cat.items || []).filter((item) =>
                (item.applicable_locations || []).includes(currentSubtype) &&
                !hideSet.has(item.id) &&
                isItemVisible(item)
            );
            const myCustomItems = customItems.filter(
                (item) =>
                    item.categoryId === cat.id &&
                    (item.applicable_locations || []).includes(currentSubtype) &&
                    isItemVisible(item)
            );
            // 施設テンプレのアイテム(このカテゴリに属するもの)
            const facItems = (facilityItemsByCategory[cat.id] || []).filter((item) =>
                !item.applicable_locations ||
                (item.applicable_locations || []).includes(currentSubtype)
            );
            const filteredItems = [...officialItems, ...facItems, ...myCustomItems];
            if (filteredItems.length === 0) return;

            // カテゴリーごとに淡いキャンディ色(シール帳っぽい楽しさ)
            const candy = CANDY_PALETTE[catIdx % CANDY_PALETTE.length];
            const section = document.createElement('div');
            // ホバーでふわっと浮いて輝く(荷物集めのモチベ)
            section.className = `${candy.bg} border ${candy.border} rounded-3xl p-4 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:ring-2 ${candy.ring}`;

            // タイトル行 + 追加ボタン
            const titleRow = document.createElement('div');
            titleRow.className = 'flex items-center justify-between mb-3 border-b border-black/5 pb-1.5';
            const title = document.createElement('h2');
            title.className = `text-md font-bold ${candy.title}`;
            title.textContent = cat.name;
            const addBtn = document.createElement('button');
            addBtn.className =
                'text-[11px] font-bold text-gray-500 bg-white/70 hover:bg-white border border-black/10 px-2 py-0.5 rounded-full transition-colors';
            addBtn.textContent = '+ 追加';
            addBtn.addEventListener('click', () => openModal(cat.id));
            titleRow.append(title, addBtn);
            section.appendChild(titleRow);

            const itemSpace = document.createElement('div');
            itemSpace.className = 'space-y-3';
            filteredItems.forEach((item) => {
                itemSpace.appendChild(
                    createItemRow(item, checked, containers[item.id] || 'none')
                );
            });
            section.appendChild(itemSpace);
            container.appendChild(section);
        });

        // 施設専用カテゴリ(__facility__)のアイテムがあれば専用セクションを追加
        const facilityOnlyItems = (facilityItemsByCategory['__facility__'] || []).filter((item) =>
            !item.applicable_locations ||
            (item.applicable_locations || []).includes(currentSubtype)
        );
        if (facilityOnlyItems.length > 0) {
            const section = document.createElement('div');
            section.className = 'bg-blue-900/20 border border-blue-700/40 rounded-xl p-4';

            const titleRow = document.createElement('div');
            titleRow.className = 'flex items-center justify-between mb-3 border-b border-blue-700/40 pb-1';
            const title = document.createElement('h2');
            title.className = 'text-md font-bold text-blue-300';
            title.textContent = '🏥 施設指定アイテム';
            titleRow.appendChild(title);
            section.appendChild(titleRow);

            const itemSpace = document.createElement('div');
            itemSpace.className = 'space-y-3';
            facilityOnlyItems.forEach((item) => {
                itemSpace.appendChild(
                    createItemRow(item, checked, containers[item.id] || 'none')
                );
            });
            section.appendChild(itemSpace);
            container.appendChild(section);
        }
    } else {
        // コンテナ別ビュー
        const allFilteredItems = [];
        appData.categories.forEach((cat) => {
            (cat.items || []).forEach((item) => {
                if (
                    (item.applicable_locations || []).includes(currentSubtype) &&
                    !hideSet.has(item.id) &&
                    isItemVisible(item)
                ) {
                    allFilteredItems.push({ ...item, categoryName: cat.name });
                }
            });
            // 施設テンプレのカテゴリ別アイテム
            (facilityItemsByCategory[cat.id] || []).forEach((item) => {
                if (!item.applicable_locations || (item.applicable_locations || []).includes(currentSubtype)) {
                    allFilteredItems.push({ ...item, categoryName: cat.name });
                }
            });
        });
        // 施設専用カテゴリのアイテム
        (facilityItemsByCategory['__facility__'] || []).forEach((item) => {
            if (!item.applicable_locations || (item.applicable_locations || []).includes(currentSubtype)) {
                allFilteredItems.push({ ...item, categoryName: '🏥 施設指定' });
            }
        });
        customItems.forEach((item) => {
            if ((item.applicable_locations || []).includes(currentSubtype) && isItemVisible(item)) {
                allFilteredItems.push(item);
            }
        });

        // ===== 「箱に詰める」モード: 達成コレクション + 使い方 + いま詰めている箱 + タップ割り当て =====
        container.appendChild(buildBoxStampBanner());
        const guide = buildPackGuide();
        if (guide) container.appendChild(guide);
        container.appendChild(buildActiveBoxBar());

        const activeBox = getActiveBox();

        // カテゴリ順にグルーピング
        const groups = [];
        const groupIndex = {};
        allFilteredItems.forEach((item) => {
            const key = item.categoryName || 'その他';
            if (groupIndex[key] === undefined) {
                groupIndex[key] = groups.length;
                groups.push({ name: key, items: [] });
            }
            groups[groupIndex[key]].items.push(item);
        });

        groups.forEach((group) => {
            const section = document.createElement('div');
            section.className = 'bg-slate-800/60 border border-gray-700/60 rounded-xl p-3';
            const title = document.createElement('p');
            title.className = 'text-xs font-bold text-gray-400 px-1 pb-2';
            title.textContent = group.name;
            section.appendChild(title);
            const list = document.createElement('div');
            list.className = 'space-y-1';
            group.items.forEach((item) => {
                list.appendChild(createPackItemRow(item, checked, containers[item.id], activeBox));
            });
            section.appendChild(list);
            container.appendChild(section);
        });
    }

    updateProgress();
}

// カテゴリー用の淡いキャンディ色(ライト背景で映え、文字は濃色で読みやすい)
const CANDY_PALETTE = [
    { bg: 'bg-pink-50', border: 'border-pink-200', title: 'text-pink-500', ring: 'hover:ring-pink-300' },
    { bg: 'bg-sky-50', border: 'border-sky-200', title: 'text-sky-600', ring: 'hover:ring-sky-300' },
    { bg: 'bg-amber-50', border: 'border-amber-200', title: 'text-amber-600', ring: 'hover:ring-amber-300' },
    { bg: 'bg-violet-50', border: 'border-violet-200', title: 'text-violet-500', ring: 'hover:ring-violet-300' },
    { bg: 'bg-emerald-50', border: 'border-emerald-200', title: 'text-emerald-600', ring: 'hover:ring-emerald-300' },
    { bg: 'bg-rose-50', border: 'border-rose-200', title: 'text-rose-500', ring: 'hover:ring-rose-300' },
];

// 箱ごとの色(実物の箱に同色シールを貼れば対応が直感的)。pale=非選択時のキャンディ色
const BOX_PALETTE = [
    { dot: 'bg-teal-500',    badge: 'bg-teal-600',    chipBg: 'bg-teal-600',    chipBorder: 'border-teal-700',    pale: 'bg-teal-100 text-teal-700 border-teal-300' },
    { dot: 'bg-sky-500',     badge: 'bg-sky-600',     chipBg: 'bg-sky-600',     chipBorder: 'border-sky-700',     pale: 'bg-sky-100 text-sky-700 border-sky-300' },
    { dot: 'bg-amber-500',   badge: 'bg-amber-600',   chipBg: 'bg-amber-600',   chipBorder: 'border-amber-700',   pale: 'bg-amber-100 text-amber-700 border-amber-300' },
    { dot: 'bg-rose-500',    badge: 'bg-rose-600',    chipBg: 'bg-rose-600',    chipBorder: 'border-rose-700',    pale: 'bg-rose-100 text-rose-700 border-rose-300' },
    { dot: 'bg-violet-500',  badge: 'bg-violet-600',  chipBg: 'bg-violet-600',  chipBorder: 'border-violet-700',  pale: 'bg-violet-100 text-violet-700 border-violet-300' },
    { dot: 'bg-emerald-500', badge: 'bg-emerald-600', chipBg: 'bg-emerald-600', chipBorder: 'border-emerald-700', pale: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
];

function getBoxColor(id) {
    const boxes = getAllContainers().slice(1);
    const idx = boxes.findIndex((b) => b.id === id);
    return BOX_PALETTE[(idx >= 0 ? idx : 0) % BOX_PALETTE.length];
}

function getActiveBox() {
    const boxes = getAllContainers().slice(1);
    const saved = getState('activeBox', null);
    if (saved && boxes.some((b) => b.id === saved)) return saved;
    return boxes.length ? boxes[0].id : null;
}

function setActiveBox(id) {
    setState('activeBox', id);
    renderChecklist();
}

// アイテムをタップしたとき: アクティブな箱に入れる / 取り出す
function packTap(itemId, srcEl) {
    const checked = getState('checked', {});
    const containers = getState('containers', {});
    const active = getActiveBox();
    if (checked[itemId] && containers[itemId] === active) {
        // すでにアクティブな箱に入っている → 取り出す
        delete checked[itemId];
        delete containers[itemId];
    } else {
        // 未割り当て/別の箱 → アクティブな箱へ入れる(チェックも付ける)
        checked[itemId] = true;
        containers[itemId] = active;
        // 積み上がる演出 + 中身が変わった箱の「詰め終わり」✅は解除
        floatPlusOne(srcEl);
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* noop */ } }
        const sealed = getSealedBoxes();
        if (sealed[active]) { delete sealed[active]; setState('sealedBoxes', sealed); }
    }
    setState('checked', checked);
    setState('containers', containers);
    renderChecklist();
}

// 「箱に詰める」モードの使い方ガイド。普段は畳んでおき ❔使い方 で開く
function buildPackGuide() {
    if (!getState('packGuideOpen', false)) return null;
    const box = document.createElement('div');
    box.className = 'relative bg-teal-500/10 border border-teal-500/30 rounded-2xl p-4 pr-9';

    const title = document.createElement('p');
    title.className = 'text-sm font-bold text-teal-300 mb-1';
    title.textContent = '💡 箱に詰めるモードの使い方';
    box.appendChild(title);

    const steps = document.createElement('div');
    steps.className = 'text-sm text-gray-300 space-y-0.5';
    [
        '① 上で「いま詰めている箱」を選ぶ',
        '② 入れる物をタップすると、その箱に入ります',
        '③ もう一度タップすると取り出せます',
        '④ 箱は名前の変更・追加ができます',
    ].forEach((t) => {
        const p = document.createElement('p');
        p.textContent = t;
        steps.appendChild(p);
    });
    box.appendChild(steps);

    const close = document.createElement('button');
    close.className = 'absolute top-2.5 right-2.5 w-7 h-7 rounded-lg text-gray-400 hover:text-gray-200 text-xl leading-none flex items-center justify-center';
    close.textContent = '×';
    close.setAttribute('aria-label', '使い方を閉じる');
    close.addEventListener('click', () => {
        setState('packGuideOpen', false);
        renderChecklist();
    });
    box.appendChild(close);

    return box;
}

function buildActiveBoxBar() {
    const activeBox = getActiveBox();
    const boxes = getAllContainers().slice(1);

    const card = document.createElement('div');
    card.className = 'bg-slate-800/80 border border-gray-700/60 rounded-2xl p-4';

    const titleRow = document.createElement('div');
    titleRow.className = 'flex items-center justify-between mb-2';
    const title = document.createElement('p');
    title.className = 'text-sm font-bold text-gray-300';
    title.textContent = 'いま詰めている箱';
    const helpBtn = document.createElement('button');
    helpBtn.className =
        'shrink-0 text-xs font-bold text-teal-400 hover:text-teal-300 border border-teal-500/40 rounded-lg px-2.5 py-1 transition-colors';
    helpBtn.textContent = '❔ 使い方';
    helpBtn.addEventListener('click', () => {
        setState('packGuideOpen', !getState('packGuideOpen', false));
        renderChecklist();
    });
    titleRow.append(title, helpBtn);
    card.appendChild(titleRow);

    const sealed = getSealedBoxes();
    // 箱ごとの個数(詰まっていくのが見える)
    const containersState = getState('containers', {});
    const boxCounts = {};
    Object.values(containersState).forEach((bid) => {
        if (bid && bid !== 'none') boxCounts[bid] = (boxCounts[bid] || 0) + 1;
    });
    const chips = document.createElement('div');
    chips.className = 'flex flex-wrap gap-2';
    boxes.forEach((box) => {
        const isActive = box.id === activeBox;
        const color = getBoxColor(box.id);
        const chip = document.createElement('button');
        chip.className = `flex items-center gap-2 min-h-[48px] px-4 rounded-full font-bold border-2 transition-all ${
            isActive
                ? `${color.chipBg} text-white ${color.chipBorder} shadow-md scale-105`
                : `${color.pale} hover:brightness-95`
        }`;
        const dot = document.createElement('span');
        dot.className = `w-3 h-3 rounded-full ${isActive ? 'bg-white' : color.dot}`;
        const label = document.createElement('span');
        label.textContent = getContainerName(box.id);
        chip.append(dot, label);
        const cnt = boxCounts[box.id] || 0;
        if (cnt > 0) {
            const badge = document.createElement('span');
            badge.className = `text-xs rounded-full px-1.5 ${isActive ? 'bg-white/25' : 'bg-black/10'}`;
            badge.textContent = String(cnt);
            chip.appendChild(badge);
        }
        if (sealed[box.id]) {
            const done = document.createElement('span');
            done.textContent = '✅';
            done.title = '詰め終わり';
            chip.appendChild(done);
        }
        if (isActive) {
            const mark = document.createElement('span');
            mark.className = 'text-xs font-normal';
            mark.textContent = '✓ 選択中';
            chip.appendChild(mark);
        }
        chip.addEventListener('click', () => setActiveBox(box.id));
        chips.appendChild(chip);
    });

    const addChip = document.createElement('button');
    addChip.className =
        'flex items-center gap-1 min-h-[48px] px-4 rounded-full font-bold text-teal-500 bg-white border-2 border-dashed border-teal-400 hover:bg-teal-50 transition-colors';
    addChip.textContent = '＋ 箱を追加';
    addChip.addEventListener('click', addContainer);
    chips.appendChild(addChip);
    card.appendChild(chips);

    const activeName = getContainerName(activeBox);

    // 👇 タップ誘導
    const hint = document.createElement('p');
    hint.className = 'text-sm font-bold text-teal-500 mt-3';
    hint.textContent = `👇 下の物をタップすると「${activeName}」に入ります`;
    card.appendChild(hint);

    // C: この箱を詰め終わった(大きく目立つボタン。押すとお祝い + ✅が積み上がる)
    const sealBtn = document.createElement('button');
    sealBtn.className =
        'w-full mt-3 flex items-center justify-center gap-2 text-base font-bold text-white bg-teal-500 hover:bg-teal-600 active:scale-[0.98] rounded-xl px-4 py-3.5 transition-all shadow-lg';
    sealBtn.textContent = `✅「${activeName}」を詰め終わった！`;
    sealBtn.addEventListener('click', sealActiveBox);
    card.appendChild(sealBtn);

    // 小さな副次アクション(名前変更 / 削除)
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-2 mt-2';
    const renameBtn = document.createElement('button');
    renameBtn.className =
        'inline-flex items-center gap-1.5 text-xs font-bold text-teal-500 bg-teal-500/10 border border-teal-500/30 hover:bg-teal-500/20 rounded-lg px-3 py-2 transition-colors';
    renameBtn.textContent = `✏️「${activeName}」の名前を変更`;
    renameBtn.addEventListener('click', () => renameContainer(activeBox));
    actions.appendChild(renameBtn);
    if (isCustomContainer(activeBox)) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className =
            'inline-flex items-center gap-1.5 text-xs font-bold text-red-400 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 rounded-lg px-3 py-2 transition-colors';
        deleteBtn.textContent = '🗑️ この箱を削除';
        deleteBtn.addEventListener('click', () => deleteContainer(activeBox));
        actions.appendChild(deleteBtn);
    }
    card.appendChild(actions);

    return card;
}

// パックモードの達成コレクション(詰め終わった箱が✅で溜まる)
function buildBoxStampBanner() {
    const boxes = getAllContainers().slice(1);
    const sealed = getSealedBoxes();
    const doneCount = boxes.filter((b) => sealed[b.id]).length;

    const banner = document.createElement('div');
    banner.className = 'rounded-2xl p-4 text-white shadow bg-gradient-to-r from-teal-500 to-emerald-500';

    const head = document.createElement('div');
    head.className = 'flex items-center justify-between mb-2';
    const t = document.createElement('p');
    t.className = 'text-sm font-bold';
    t.textContent = '🎁 詰め終わった箱';
    const c = document.createElement('p');
    c.className = 'text-sm font-bold';
    c.textContent = `${doneCount} / ${boxes.length} 箱`;
    head.append(t, c);
    banner.appendChild(head);

    const row = document.createElement('div');
    row.className = 'flex flex-wrap gap-2';
    boxes.forEach((b) => {
        const isSealed = Boolean(sealed[b.id]);
        const cell = document.createElement('div');
        cell.className = `min-w-[44px] h-11 px-2 rounded-xl flex items-center justify-center text-lg ${
            isSealed ? 'bg-white/25' : 'bg-white/10 border-2 border-dashed border-white/40 opacity-80'
        }`;
        cell.textContent = isSealed ? '✅' : '📦';
        cell.title = getContainerName(b.id);
        row.appendChild(cell);
    });
    banner.appendChild(row);
    return banner;
}

function createPackItemRow(item, checked, currentBox, activeBox) {
    const isChecked = Boolean(checked[item.id]);
    const inBox = Boolean(currentBox) && currentBox !== 'none';
    const color = inBox ? getBoxColor(currentBox) : null;

    const row = document.createElement('button');
    // 進捗カウント用マーカー(パック表示は input を使わないため)
    row.setAttribute('data-pack-item', isChecked ? 'checked' : 'unchecked');
    // 箱に入れると、その箱のキャンディ色に色づく(箱との繋がりが見える)
    row.className = `w-full flex items-center gap-3 min-h-[56px] px-3 py-2.5 rounded-2xl border-2 transition-all text-left ${
        inBox
            ? color.pale
            : 'bg-slate-800/30 border-transparent hover:bg-slate-800/50'
    }`;

    const mark = document.createElement('span');
    mark.className =
        'w-7 h-7 rounded-full flex items-center justify-center font-bold shrink-0 ' +
        (isChecked ? `${color ? color.badge : 'bg-teal-600'} text-white` : 'border-2 border-gray-400');
    mark.textContent = isChecked ? '✓' : '';
    row.appendChild(mark);

    const nameWrap = document.createElement('span');
    nameWrap.className =
        'flex-1 flex items-center flex-wrap gap-1.5 ' + (isChecked ? 'text-gray-200' : 'text-gray-400');
    const name = document.createElement('span');
    name.textContent = item.name;
    nameWrap.appendChild(name);

    const qty = item.quantity && item.quantity > 1 ? item.quantity : null;
    if (qty) {
        const qtyBadge = document.createElement('span');
        qtyBadge.className =
            'text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded';
        qtyBadge.textContent = `×${qty}`;
        nameWrap.appendChild(qtyBadge);
    }
    if (item.isCustom) {
        const b = document.createElement('span');
        b.className = 'text-[9px] text-teal-600 border border-teal-700/40 px-1 py-0.5 rounded';
        b.textContent = 'カスタム';
        nameWrap.appendChild(b);
    }
    if (item.isFacility) {
        const b = document.createElement('span');
        b.className = 'text-[9px] text-blue-400 border border-blue-500/40 px-1 py-0.5 rounded';
        b.textContent = '🏥施設';
        nameWrap.appendChild(b);
    }
    row.appendChild(nameWrap);

    const status = document.createElement('span');
    if (inBox) {
        status.className = `shrink-0 text-xs font-bold text-white px-2.5 py-1 rounded-full ${color.badge}`;
        status.textContent = getContainerName(currentBox);
    } else {
        status.className = 'shrink-0 text-xs text-gray-500';
        status.textContent = `タップで${getContainerName(activeBox)}へ`;
    }
    row.appendChild(status);

    row.addEventListener('click', () => packTap(item.id, row));
    return row;
}

function renderReturnChecklist() {
    const container = $('checklist-container');
    container.textContent = '';

    const checked = getState('checked', {});
    const returnChecked = getState('returnChecked', {});
    const containers = getState('containers', {});
    const customItems = getCustomItems();

    // 3層マージ用
    const hideSet = getFacilityHideSet();

    // 準備時にチェック済みのアイテムのみ対象
    const allItems = [];
    appData.categories.forEach((cat) => {
        (cat.items || []).forEach((item) => {
            if (
                (item.applicable_locations || []).includes(currentSubtype) &&
                checked[item.id] &&
                !hideSet.has(item.id) &&
                isItemVisible(item)
            ) {
                allItems.push({ ...item, categoryName: cat.name });
            }
        });
    });
    customItems.forEach((item) => {
        if (
            (item.applicable_locations || []).includes(currentSubtype) &&
            checked[item.id] &&
            isItemVisible(item)
        ) {
            allItems.push(item);
        }
    });

    // 数えない。「大事なもの」を上に、その他は畳む(消耗品は表示しない)
    const returnables = allItems.filter((item) => !item.consumable);

    if (returnables.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-center py-8 text-gray-500 text-sm';
        empty.textContent = '確認する持ち物がありません（準備でチェックした物が対象です）。';
        container.appendChild(empty);
        return;
    }

    const important = returnables.filter((item) => item.important);
    const others = returnables.filter((item) => !item.important);

    if (important.length > 0) {
        container.appendChild(
            buildReturnSection('🌟 わすれたら困るもの', important, returnChecked, containers, 'text-amber-700', 'bg-amber-50 border-amber-200', 'hover:ring-amber-300')
        );
    }

    if (others.length > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'space-y-2';
        const open = getState('returnOthersOpen', false);
        const toggle = document.createElement('button');
        toggle.className = 'w-full text-sm font-bold text-gray-500 bg-white border border-gray-200 rounded-2xl px-4 py-2.5 hover:bg-gray-50 transition-colors';
        toggle.textContent = open ? '🔼 その他を閉じる' : `👜 その他（${others.length}）も見る`;
        toggle.addEventListener('click', () => {
            setState('returnOthersOpen', !getState('returnOthersOpen', false));
            renderChecklist();
        });
        wrap.appendChild(toggle);
        // 中身は常に描画し、閉じている時は隠すだけ(項目は残す)
        const section = buildReturnSection('その他', others, returnChecked, containers, 'text-gray-600', 'bg-white border-gray-200');
        if (!open) section.classList.add('hidden');
        wrap.appendChild(section);
        container.appendChild(wrap);
    }
}

function buildReturnSection(titleText, items, returnChecked, containers, titleColor, cardClass, ringClass = 'hover:ring-gray-300') {
    const section = document.createElement('div');
    // ホバーで浮いて輝く(準備リストと同じ気持ちよさ)
    section.className = `${cardClass} border rounded-3xl p-4 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:ring-2 ${ringClass}`;
    const title = document.createElement('h2');
    title.className = `text-md font-bold ${titleColor} mb-3`;
    title.textContent = titleText;
    section.appendChild(title);
    const list = document.createElement('div');
    list.className = 'space-y-2';
    items.forEach((item) => list.appendChild(createReturnItemRow(item, returnChecked, containers[item.id] || 'none')));
    section.appendChild(list);
    return section;
}

function createReturnItemRow(item, returnChecked, currentBox) {
    const isReturned = Boolean(returnChecked[item.id]);
    const qty = item.quantity && item.quantity > 1 ? item.quantity : null;
    const boxId = currentBox !== 'none' ? currentBox : null;

    // 戻ってきたら緑に色づく丸チェックのカード
    const itemRow = document.createElement('div');
    itemRow.className = `flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-2xl border-2 border-transparent transition-colors ${
        isReturned ? 'bg-green-500/15' : 'hover:bg-gray-700/10'
    }`;

    const left = document.createElement('div');
    left.className = 'flex items-start gap-3 flex-1';
    const label = document.createElement('label');
    label.className = 'flex items-center gap-3 cursor-pointer flex-1';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isReturned;
    checkbox.className = 'peer sr-only';

    const mark = document.createElement('span');
    mark.className =
        'w-7 h-7 rounded-full border-2 border-gray-400 text-transparent flex items-center justify-center text-sm font-bold transition-all peer-checked:bg-green-500 peer-checked:border-green-500 peer-checked:text-white shrink-0';
    mark.textContent = '✓';

    checkbox.addEventListener('change', () => {
        itemRow.classList.toggle('bg-green-500/15', checkbox.checked);
        itemRow.classList.toggle('hover:bg-gray-700/10', !checkbox.checked);
        if (checkbox.checked) celebrateCheck(mark);
        setReturnChecked(item.id, checkbox.checked);
    });

    const textWrap = document.createElement('div');
    textWrap.className = 'flex flex-col';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'flex items-center flex-wrap gap-1.5';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'text-gray-300 text-sm leading-relaxed';
    nameSpan.textContent = item.name;
    nameWrap.appendChild(nameSpan);

    if (qty) {
        const qtyBadge = document.createElement('span');
        qtyBadge.className =
            'text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded';
        qtyBadge.textContent = `×${qty}`;
        nameWrap.appendChild(qtyBadge);
    }
    textWrap.appendChild(nameWrap);

    if (boxId) {
        const boxBadge = document.createElement('span');
        boxBadge.className = 'text-[10px] text-gray-500 mt-0.5';
        boxBadge.textContent = `📦 ${getContainerName(boxId)}`;
        textWrap.appendChild(boxBadge);
    }

    label.append(checkbox, mark, textWrap);
    left.appendChild(label);
    itemRow.appendChild(left);

    return itemRow;
}

function createItemRow(item, checked, currentBox, showCategoryBadge = false) {
    const qty = item.quantity && item.quantity > 1 ? item.quantity : null;
    const isChecked = Boolean(checked[item.id]);

    // チェックで色が付くカード風の行(集めてる感)
    const itemRow = document.createElement('div');
    itemRow.className = `flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-2xl border border-transparent transition-colors ${
        isChecked ? 'bg-teal-500/15' : 'hover:bg-gray-700/10'
    }`;

    // 左: まる型チェック + 名前
    const left = document.createElement('div');
    left.className = 'flex items-start gap-3 flex-1';
    const label = document.createElement('label');
    label.className = 'flex items-center gap-3 cursor-pointer flex-1';

    // 本物のcheckboxは残し(テスト/アクセシビリティ)、見た目は丸チェックに
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isChecked;
    checkbox.className = 'peer sr-only';

    const mark = document.createElement('span');
    mark.className =
        'shrink-0 w-7 h-7 rounded-full border-2 border-gray-400 text-transparent flex items-center justify-center text-sm font-bold transition-all peer-checked:bg-teal-500 peer-checked:border-teal-500 peer-checked:text-white';
    mark.textContent = '✓';

    checkbox.addEventListener('change', () => {
        itemRow.classList.toggle('bg-teal-500/15', checkbox.checked);
        itemRow.classList.toggle('hover:bg-gray-700/10', !checkbox.checked);
        if (checkbox.checked) {
            celebrateCheck(mark);
            floatPlusOne(mark);
        }
        setChecked(item.id, checkbox.checked);
    });

    const textWrap = document.createElement('div');
    textWrap.className = 'flex flex-col';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'flex items-center flex-wrap gap-1.5';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'text-gray-300 text-sm leading-relaxed';
    nameSpan.textContent = item.name;
    nameWrap.appendChild(nameSpan);

    if (qty) {
        const qtyBadge = document.createElement('span');
        qtyBadge.className =
            'text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded';
        qtyBadge.textContent = `×${qty}`;
        nameWrap.appendChild(qtyBadge);
    }
    if (item.isCustom) {
        const customBadge = document.createElement('span');
        customBadge.className = 'text-[9px] text-teal-600 border border-teal-700/40 px-1 py-0.5 rounded';
        customBadge.textContent = 'カスタム';
        nameWrap.appendChild(customBadge);
    }
    if (item.isFacility) {
        const facBadge = document.createElement('span');
        facBadge.className = 'text-[9px] text-blue-400 border border-blue-500/40 px-1 py-0.5 rounded';
        facBadge.textContent = '🏥施設';
        nameWrap.appendChild(facBadge);
    }
    textWrap.appendChild(nameWrap);

    if (showCategoryBadge && item.categoryName) {
        const badge = document.createElement('span');
        badge.className = 'text-[10px] text-gray-500 mt-0.5';
        badge.textContent = item.categoryName;
        textWrap.appendChild(badge);
    }

    label.append(checkbox, mark, textWrap);
    left.appendChild(label);

    // 右: 箱セレクト + (カスタムなら削除ボタン)
    const right = document.createElement('div');
    right.className = 'flex items-center gap-2 self-end sm:self-center';

    const select = document.createElement('select');
    select.className =
        'text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-teal-400 focus:ring-teal-500 focus:border-teal-500';
    getAllContainers().forEach((b) => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = getContainerName(b.id);
        opt.selected = currentBox === b.id;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => setContainer(item.id, select.value));

    right.append(select);

    if (item.isCustom) {
        const delBtn = document.createElement('button');
        delBtn.className = 'text-xs text-red-600 hover:text-red-400 transition-colors px-1 font-bold';
        delBtn.textContent = '×';
        delBtn.title = 'このアイテムを削除';
        delBtn.addEventListener('click', () => {
            if (confirm(`「${item.name}」を削除しますか？`)) deleteCustomItem(item.id);
        });
        right.appendChild(delBtn);
    }

    itemRow.append(left, right);
    return itemRow;
}

// ---------- State mutations ----------

function setChecked(itemId, isChecked) {
    const checked = getState('checked', {});
    if (isChecked) checked[itemId] = true;
    else delete checked[itemId];
    setState('checked', checked);
    updateProgress();
}

function getImportantReturnables() {
    const checked = getState('checked', {});
    const hideSet = getFacilityHideSet();
    const res = [];
    appData.categories.forEach((cat) => (cat.items || []).forEach((item) => {
        if (
            item.important && !item.consumable &&
            (item.applicable_locations || []).includes(currentSubtype) &&
            checked[item.id] && !hideSet.has(item.id) && isItemVisible(item)
        ) res.push(item);
    }));
    return res;
}

function setReturnChecked(itemId, isChecked) {
    const returnChecked = getState('returnChecked', {});
    if (isChecked) returnChecked[itemId] = true;
    else delete returnChecked[itemId];
    setState('returnChecked', returnChecked);

    // 大事なものが全部そろったら小さくお祝い(数えない・でも安心)
    if (isChecked) {
        const imp = getImportantReturnables();
        const justImportant = imp.some((it) => it.id === itemId);
        if (justImportant && imp.length > 0 && imp.every((it) => returnChecked[it.id])) {
            launchConfetti(14);
            showToast('大事なものはOK！🎉');
        }
    }
}

function setContainer(itemId, boxId) {
    const containers = getState('containers', {});
    if (boxId === 'none') delete containers[itemId];
    else containers[itemId] = boxId;
    setState('containers', containers);
    if (viewMode === 'container') renderChecklist();
}

function deleteCustomItem(itemId) {
    setState('customItems', getCustomItems().filter((i) => i.id !== itemId));
    const checked = getState('checked', {});
    const containers = getState('containers', {});
    delete checked[itemId];
    delete containers[itemId];
    setState('checked', checked);
    setState('containers', containers);
    renderChecklist();
}

function addContainer() {
    const list = getCustomContainers();
    if (list.length >= 20) {
        showToast('コンテナは最大20個までです');
        return;
    }
    const input = prompt('新しいコンテナの名前:', `箱 ${CONTAINERS.length + list.length}`);
    if (input === null) return;
    const name = input.trim().slice(0, 20) || `箱 ${CONTAINERS.length + list.length}`;
    const id = `cc_${Date.now()}`;
    setState('customContainers', [...list, { id, name }]);
    setState('activeBox', id);
    renderChecklist();
    showToast(`「${name}」を追加しました`);
}

function deleteContainer(containerId) {
    if (!isCustomContainer(containerId)) return;
    const name = getContainerName(containerId);
    if (!confirm(`コンテナ「${name}」を削除しますか？\n中のアイテムは「未割り当て」に戻ります。`)) return;

    // このコンテナに割り当てられたアイテムを未割り当てに戻す
    const containers = getState('containers', {});
    Object.keys(containers).forEach((itemId) => {
        if (containers[itemId] === containerId) delete containers[itemId];
    });
    setState('containers', containers);

    // コンテナ本体と名前の上書きを削除
    setState('customContainers', getCustomContainers().filter((c) => c.id !== containerId));
    const names = getState('containerNames', {});
    if (names[containerId] !== undefined) {
        delete names[containerId];
        setState('containerNames', names);
    }

    renderChecklist();
    showToast(`「${name}」を削除しました`);
}

function renameContainer(containerId) {
    const current = getContainerName(containerId);
    const newName = prompt('コンテナ名を変更:', current);
    if (newName === null) return;
    const names = getState('containerNames', {});
    const trimmed = newName.trim().slice(0, 20);
    const def = getAllContainers().find((c) => c.id === containerId);
    if (!trimmed || trimmed === (def ? def.name : containerId)) {
        delete names[containerId];
    } else {
        names[containerId] = trimmed;
    }
    setState('containerNames', names);
    renderChecklist();
}

function updateProgress() {
    let total;
    let done;
    if (viewMode === 'container' && !returnMode) {
        // 「箱に詰める」表示はタップ行(input無し)なのでマーカーで数える
        total = document.querySelectorAll('#checklist-container [data-pack-item]').length;
        done = document.querySelectorAll('#checklist-container [data-pack-item="checked"]').length;
    } else {
        total = document.querySelectorAll('input[type="checkbox"]:not([disabled])').length;
        done = document.querySelectorAll('input[type="checkbox"]:not([disabled]):checked').length;
    }
    // 完了はユーザーが「準備できた!」で宣言する → 分母(ゴール)は出さず「貯まった数」を見せる
    $('progress-text').textContent = done > 0 ? `${done}コ そろえた 🎒` : 'これから準備 🎒';
    $('progress-bar').style.width = total > 0 ? `${(done / total) * 100}%` : '0%';

    const msgEl = document.getElementById('progress-msg');
    if (msgEl) {
        if (done === 0) {
            msgEl.textContent = '';
        } else if (done % 5 === 0) {
            msgEl.textContent = `🎉 ${done}コ！その調子！`;
        } else {
            msgEl.textContent = 'いい調子です 🎈';
        }
    }
}

// ---------- ちょっとしたご褒美演出 ----------

// 操作した瞬間の小さなポップ(気持ちよさ + 軽い振動)
function celebrateCheck(el) {
    try {
        el.animate(
            [{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }],
            { duration: 260, easing: 'ease-out' }
        );
    } catch (e) { /* Web Animations 非対応でも無害 */ }
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* noop */ } }
}

// 積み上がる感: 操作した要素の位置から「＋1」がふわっと浮いて消える
function floatPlusOne(el) {
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    const tag = document.createElement('div');
    tag.textContent = '＋1';
    tag.style.position = 'fixed';
    tag.style.left = `${r.left + r.width / 2}px`;
    tag.style.top = `${r.top}px`;
    tag.style.transform = 'translate(-50%, 0)';
    tag.style.color = '#0d9488';
    tag.style.fontWeight = '800';
    tag.style.fontSize = '14px';
    tag.style.pointerEvents = 'none';
    tag.style.zIndex = '60';
    document.body.appendChild(tag);
    try {
        const anim = tag.animate(
            [
                { transform: 'translate(-50%, 0)', opacity: 0 },
                { transform: 'translate(-50%, -14px)', opacity: 1, offset: 0.3 },
                { transform: 'translate(-50%, -40px)', opacity: 0 },
            ],
            { duration: 700, easing: 'ease-out' }
        );
        anim.onfinish = () => tag.remove();
    } catch (e) { tag.remove(); }
}

// 紙吹雪(count で大きさ調整。準備完了=大, 箱=小)
function launchConfetti(count = 32) {
    const colors = ['#2dd4bf', '#f472b6', '#fbbf24', '#ffffff', '#34d399'];
    const container = document.createElement('div');
    container.className = 'fixed inset-0 pointer-events-none z-[60] overflow-hidden';
    document.body.appendChild(container);
    for (let i = 0; i < count; i++) {
        const piece = document.createElement('div');
        const size = 6 + Math.random() * 6;
        piece.style.position = 'absolute';
        piece.style.left = `${10 + Math.random() * 80}%`;
        piece.style.top = '-5%';
        piece.style.width = `${size}px`;
        piece.style.height = `${size}px`;
        piece.style.backgroundColor = colors[i % colors.length];
        piece.style.borderRadius = Math.random() < 0.5 ? '50%' : '2px';
        container.appendChild(piece);
        const dx = (Math.random() - 0.5) * 160;
        const dy = window.innerHeight * (0.7 + Math.random() * 0.5);
        const rot = (Math.random() - 0.5) * 720;
        try {
            const anim = piece.animate(
                [
                    { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
                    { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg)`, opacity: 1, offset: 0.85 },
                    { transform: `translate(${dx}px, ${dy + 40}px) rotate(${rot}deg)`, opacity: 0 },
                ],
                { duration: 1600 + Math.random() * 800, easing: 'cubic-bezier(.2,.6,.4,1)' }
            );
            anim.onfinish = () => piece.remove();
        } catch (e) { piece.remove(); }
    }
    setTimeout(() => container.remove(), 2800);
}

// 箱を詰め終わったときの状態(✅が積み上がる)
function getSealedBoxes() {
    return getState('sealedBoxes', {});
}

// A: ユーザーが「準備できた!」と宣言したとき → 送り出しの演出
function celebratePrepDone() {
    launchConfetti(44);
    if (navigator.vibrate) { try { navigator.vibrate([20, 40, 20, 40, 60]); } catch (e) { /* noop */ } }
    showSendOff();
}

// 送り出しの瞬間: 温かい「いってらっしゃい」オーバーレイ
function showSendOff() {
    const name = getPersonName();
    showCelebrationOverlay(
        '🎈',
        name ? `${name}さん、いってらっしゃい！` : 'いってらっしゃい！',
        '準備おつかれさま。気をつけてね 🍀',
        'text-teal-600'
    );
}

// ---------- おでかけ記録(調子 + 回数 + また行こう) ----------

const MOODS = ['😟', '😐', '🙂', '😊', '😄'];

function renderMood() {
    const row = $('mood-row');
    if (!row) return;
    row.textContent = '';
    const current = getState('lastMood', -1);
    MOODS.forEach((face, i) => {
        const b = document.createElement('button');
        const on = i === current;
        b.className = `w-11 h-11 rounded-full text-2xl flex items-center justify-center transition-all border-2 ${
            on ? 'bg-amber-100 border-amber-400 scale-110' : 'bg-gray-50 border-transparent hover:bg-amber-50'
        }`;
        b.textContent = face;
        b.setAttribute('aria-label', `調子 ${i + 1}`);
        b.addEventListener('click', () => { setState('lastMood', i); renderMood(); });
        row.appendChild(b);
    });
}

function renderReturnWelcome() {
    const el = $('return-welcome-msg');
    if (!el) return;
    const count = getState('outingCount', 0);
    const name = getPersonName();
    el.textContent = count > 0
        ? `${name ? name + 'さん、' : ''}これまで ${count}回のおでかけ、おつかれさま 🎒`
        : 'おつかれさま。忘れ物がないか、いっしょに確認しましょう 🍵';
}

// ③ 日記の写真(思い出) — ローカルに小さく圧縮して保存
let pendingDiaryPhoto = '';

async function resizeToDataUrl(file, maxSide, quality) {
    const img = await loadImageElement(file);
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
}

async function handleDiaryPhoto(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
        pendingDiaryPhoto = await resizeToDataUrl(file, 480, 0.7);
        const prev = $('diary-photo-preview');
        prev.src = pendingDiaryPhoto;
        prev.classList.remove('hidden');
        $('diary-photo-clear').classList.remove('hidden');
    } catch (err) {
        showToast('写真を読み込めませんでした');
    }
}

function clearDiaryPhoto() {
    pendingDiaryPhoto = '';
    $('diary-photo-input').value = '';
    $('diary-photo-preview').classList.add('hidden');
    $('diary-photo-clear').classList.add('hidden');
}

function handleTadaima() {
    // ① 日記エントリを記録
    const dest = (getAllLocations().find((l) => l.id === currentSubtype) || {}).name || 'おでかけ';
    const noteEl = $('diary-note-input');
    const note = noteEl ? noteEl.value.trim().slice(0, 100) : '';
    setState('diary', [...getDiary(), {
        date: new Date().toISOString().slice(0, 10),
        dest,
        mood: getState('lastMood', -1),
        note,
        photo: pendingDiaryPhoto || '',
    }]);
    if (noteEl) noteEl.value = '';
    clearDiaryPhoto();

    const count = getState('outingCount', 0) + 1;
    setState('outingCount', count);
    renderReturnWelcome();
    launchConfetti(30);
    if (navigator.vibrate) { try { navigator.vibrate([20, 40, 30]); } catch (e) { /* noop */ } }
    const name = getPersonName();
    showCelebrationOverlay('🏠', `${count}回目のおでかけ！`, `${name ? name + 'さん、' : ''}おつかれさまでした。また 一緒に準備しましょう 🍀`, 'text-amber-600');
}

// ---------- おでかけ日記 + 調子グラフ ----------

const MOOD_COLORS = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#34d399'];

function getDiary() {
    const d = getState('diary', []);
    return Array.isArray(d) ? d : [];
}

function openDiary() {
    renderDiary();
    const m = $('diary-modal');
    m.classList.remove('hidden');
    m.classList.add('flex');
}

function closeDiary() {
    const m = $('diary-modal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

function renderDiary() {
    const entries = getDiary();
    const graph = $('diary-graph');
    const list = $('diary-list');
    graph.textContent = '';
    list.textContent = '';
    if (entries.length === 0) {
        const p = document.createElement('p');
        p.className = 'text-sm text-gray-500 text-center py-6';
        p.textContent = 'まだ記録がありません。おかえりのときに「🏠 ただいま！」で記録できます 🍀';
        list.appendChild(p);
        return;
    }
    graph.appendChild(buildMoodGraph(entries));
    [...entries].reverse().forEach((e) => list.appendChild(buildDiaryRow(e)));
}

function buildMoodGraph(entries) {
    const wrap = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'text-xs font-bold text-gray-500 mb-2';
    title.textContent = '調子の推移（最近）';
    wrap.appendChild(title);

    const chart = document.createElement('div');
    chart.className = 'flex items-end justify-center gap-1 h-24 bg-amber-50 rounded-2xl p-2';
    entries.slice(-14).forEach((e) => {
        const m = typeof e.mood === 'number' && e.mood >= 0 ? e.mood : 2;
        const col = document.createElement('div');
        col.className = 'flex-1 flex flex-col justify-end h-full';
        const bar = document.createElement('div');
        bar.className = 'mx-auto w-3 rounded-t-lg';
        bar.style.height = `${((m + 1) / 5) * 100}%`;
        bar.style.backgroundColor = MOOD_COLORS[m] || '#facc15';
        bar.title = `${e.date} ${MOODS[m] || ''}`;
        col.appendChild(bar);
        chart.appendChild(col);
    });
    wrap.appendChild(chart);
    return wrap;
}

function buildDiaryRow(e) {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 bg-gray-50 rounded-2xl px-3 py-2';
    const face = document.createElement('span');
    face.className = 'text-2xl shrink-0';
    face.textContent = typeof e.mood === 'number' && e.mood >= 0 ? MOODS[e.mood] : '🎒';
    const body = document.createElement('div');
    body.className = 'flex-1 min-w-0';
    const top = document.createElement('p');
    top.className = 'text-sm font-bold text-gray-800';
    top.textContent = `${e.date}　🎒 ${e.dest || 'おでかけ'}`;
    body.appendChild(top);
    if (e.note) {
        const note = document.createElement('p');
        note.className = 'text-xs text-gray-500';
        note.textContent = e.note;
        body.appendChild(note);
    }
    row.append(face, body);
    if (e.photo) {
        const img = document.createElement('img');
        img.src = e.photo;
        img.className = 'w-12 h-12 rounded-lg object-cover shrink-0';
        img.alt = '';
        row.appendChild(img);
    }
    return row;
}

// 送り出し/おかえり 共通のお祝いオーバーレイ
function showCelebrationOverlay(emojiChar, titleText, subText, titleColor) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[70] flex items-center justify-center p-6 bg-black/30';
    const card = document.createElement('div');
    card.className = 'bg-white rounded-3xl shadow-2xl px-8 py-10 text-center max-w-xs w-full';
    const emoji = document.createElement('div');
    emoji.className = 'text-6xl mb-3';
    emoji.textContent = emojiChar;
    const h = document.createElement('p');
    h.className = `text-2xl font-bold mb-1 ${titleColor}`;
    h.textContent = titleText;
    const sub = document.createElement('p');
    sub.className = 'text-sm text-gray-600';
    sub.textContent = subText;
    card.append(emoji, h, sub);
    overlay.appendChild(card);
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
    try {
        card.animate(
            [{ transform: 'scale(0.8)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
            { duration: 300, easing: 'ease-out' }
        );
    } catch (e) { /* noop */ }
    setTimeout(() => {
        overlay.style.transition = 'opacity .4s';
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 400);
    }, 3600);
}

// C: 箱を詰め終わったとき(小さなお祝い + ✅を記録)
function sealActiveBox() {
    const active = getActiveBox();
    if (!active) return;
    const sealed = getSealedBoxes();
    sealed[active] = true;
    setState('sealedBoxes', sealed);
    launchConfetti(16);
    if (navigator.vibrate) { try { navigator.vibrate([15, 30, 15]); } catch (e) { /* noop */ } }
    showToast(`${getContainerName(active)} を詰め終わりました 🎉`);
    renderChecklist();
}


function resetChecks() {
    const prev = getState('checked', {});
    if (Object.keys(prev).length === 0) {
        showToast('チェックはまだありません');
        return;
    }
    setState('checked', {});
    renderChecklist();
    showToast('チェックをリセットしました', 6000, {
        label: '元に戻す',
        onClick: () => {
            setState('checked', prev);
            renderChecklist();
            showToast('元に戻しました ✅');
        },
    });
}

function resetReturnChecks() {
    const prev = getState('returnChecked', {});
    if (Object.keys(prev).length === 0) {
        showToast('おかえりチェックはまだありません');
        return;
    }
    removeState('returnChecked');
    renderChecklist();
    showToast('おかえりチェックをリセットしました', 6000, {
        label: '元に戻す',
        onClick: () => {
            setState('returnChecked', prev);
            renderChecklist();
            showToast('元に戻しました ✅');
        },
    });
}

function resetAll() {
    if (
        !confirm('チェック・箱の割り当て・カスタムアイテムをすべて削除しますか？')
    ) {
        return;
    }
    const keys = [
        'checked',
        'skipped',
        'containers',
        'customItems',
        'containerNames',
        'customContainers',
        'activeBox',
        'packGuideOpen',
        'sealedBoxes',
        'personName',
        'memos',
        'outingCount',
        'lastMood',
        'diary',
        'returnOthersOpen',
        'specialOutings',
        'reminderDismissed',
        'pushEnabled',
        'viewMode',
        'returnChecked',
        'facilityTemplate',
        'conditions',
    ];
    const snapshot = {};
    keys.forEach((k) => {
        snapshot[k] = getState(k, null);
        removeState(k);
    });
    updateFacilityBanner();
    renderConditionToggles();
    renderChecklist();
    showToast('すべて削除しました', 8000, {
        label: '元に戻す',
        onClick: () => {
            keys.forEach((k) => {
                if (snapshot[k] === null) {
                    removeState(k);
                } else {
                    setState(k, snapshot[k]);
                }
            });
            updateFacilityBanner();
            renderConditionToggles();
            renderChecklist();
            showToast('元に戻しました ✅');
        },
    });
}


// ---------- 印刷 ----------

function handlePrint() {
    if (!appData) return;

    const locationObj = appData.locations.find((l) => l.id === currentSubtype);
    const locationName = locationObj ? locationObj.name : currentSubtype;
    const today = new Date();
    const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;

    const checked = getState('checked', {});
    const skipped = getState('skipped', {});
    const containers = getState('containers', {});
    const customItems = getCustomItems();

    const printArea = $('print-area');
    printArea.textContent = '';

    // 印刷ヘッダー
    const h1 = document.createElement('h1');
    h1.textContent = `CareReady 持ち物リスト — ${locationName}`;
    const dateLine = document.createElement('p');
    dateLine.className = 'print-date';
    dateLine.textContent = `印刷日: ${dateStr}`;
    printArea.append(h1, dateLine);

    // 3層マージ
    const hideSet = getFacilityHideSet();
    const facilityItemsByCategory = getFacilityItemsByCategory();

    // カテゴリ別にアイテムを出力(スキップ済みは除く)
    appData.categories.forEach((cat) => {
        const officialItems = (cat.items || []).filter(
            (item) =>
                (item.applicable_locations || []).includes(currentSubtype) &&
                !skipped[item.id] &&
                !hideSet.has(item.id) &&
                isItemVisible(item)
        );
        const facItems = (facilityItemsByCategory[cat.id] || []).filter((item) =>
            (!item.applicable_locations || (item.applicable_locations || []).includes(currentSubtype)) &&
            !skipped[item.id]
        );
        const myCustomItems = customItems.filter(
            (item) =>
                item.categoryId === cat.id &&
                (item.applicable_locations || []).includes(currentSubtype) &&
                !skipped[item.id] &&
                isItemVisible(item)
        );
        const filteredItems = [...officialItems, ...facItems, ...myCustomItems];
        if (filteredItems.length === 0) return;

        const catTitle = document.createElement('div');
        catTitle.className = 'print-category-title';
        catTitle.textContent = cat.name;
        printArea.appendChild(catTitle);

        filteredItems.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'print-item';

            const cb = document.createElement('span');
            cb.className = 'print-checkbox';
            cb.textContent = checked[item.id] ? '☑' : '□';

            const name = document.createElement('span');
            name.className = 'print-item-name';
            name.textContent = item.name;

            row.append(cb, name);

            if (item.quantity && item.quantity > 1) {
                const qty = document.createElement('span');
                qty.className = 'print-qty';
                qty.textContent = `×${item.quantity}`;
                row.appendChild(qty);
            }

            const boxId = containers[item.id];
            if (boxId && boxId !== 'none') {
                const box = document.createElement('span');
                box.className = 'print-box';
                box.textContent = `📦 ${getContainerName(boxId)}`;
                row.appendChild(box);
            }

            printArea.appendChild(row);
        });
    });

    window.print();
}

// ---------- Toast ----------

function showToast(message, duration = 2500, action = null) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.className =
        'fixed bottom-8 left-1/2 -translate-x-1/2 bg-gray-700 border border-gray-600 text-gray-200 text-sm px-4 py-2.5 rounded-xl shadow-xl z-50 max-w-xs transition-opacity duration-300 flex items-center justify-center gap-3';
    toast.replaceChildren();
    const span = document.createElement('span');
    span.textContent = message;
    toast.appendChild(span);
    if (action && action.label && typeof action.onClick === 'function') {
        const btn = document.createElement('button');
        btn.textContent = action.label;
        btn.className = 'shrink-0 font-bold text-teal-300 hover:text-teal-200 underline underline-offset-2';
        btn.addEventListener('click', () => {
            clearTimeout(toastTimer);
            toast.style.opacity = '0';
            action.onClick();
        });
        toast.appendChild(btn);
    }
    toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.style.opacity = '0';
    }, duration);
}

// ---------- Event wiring ----------

// 施設コードモーダル
$('fc-open-btn').addEventListener('click', openFcModal);
$('fc-modal-cancel').addEventListener('click', closeFcModal);
$('fc-modal').addEventListener('click', (e) => { if (e.target === $('fc-modal')) closeFcModal(); });
$('fc-modal-submit').addEventListener('click', handleFcModalSubmit);
$('fc-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleFcModalSubmit();
    if (e.key === 'Escape') closeFcModal();
});
$('fc-code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
});
$('facility-revoke').addEventListener('click', revokeFacilityTemplate);

// OCR取込モーダル
$('ocr-open-btn').addEventListener('click', openOcrModal);
$('ocr-modal-cancel').addEventListener('click', closeOcrModal);
$('ocr-modal').addEventListener('click', (e) => { if (e.target === $('ocr-modal')) closeOcrModal(); });
$('ocr-start-btn').addEventListener('click', handleOcrStart);
$('ocr-import-btn').addEventListener('click', handleOcrImport);

$('mode-category').addEventListener('click', () => switchViewMode('category'));
$('mode-container').addEventListener('click', () => switchViewMode('container'));
$('mode-return').addEventListener('click', () => switchReturnMode(!returnMode));
$('ready-btn').addEventListener('click', celebratePrepDone);
$('person-btn').addEventListener('click', handlePersonName);
$('memo-input').addEventListener('input', saveMemo);
$('tadaima-btn').addEventListener('click', handleTadaima);
$('diary-photo-btn').addEventListener('click', () => $('diary-photo-input').click());
$('diary-photo-input').addEventListener('change', handleDiaryPhoto);
$('diary-photo-clear').addEventListener('click', clearDiaryPhoto);
$('return-check-toggle').addEventListener('click', () => {
    returnCheckOpen = !returnCheckOpen;
    applyReturnCheckVisibility();
});
$('reminder-open').addEventListener('click', () => {
    const id = $('reminder-banner').dataset.outingId;
    if (id) {
        currentSubtype = id;
        renderTabs();
        renderChecklist();
        renderMemo();
    }
    $('reminder-banner').classList.add('hidden');
    $('reminder-banner').classList.remove('flex');
    window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('reminder-dismiss').addEventListener('click', () => {
    setState('reminderDismissed', new Date().toISOString().slice(0, 10));
    $('reminder-banner').classList.add('hidden');
    $('reminder-banner').classList.remove('flex');
});
$('push-toggle').addEventListener('click', handlePushToggle);
$('push-prompt-enable').addEventListener('click', async () => {
    await enablePush();
    renderPushToggle();
    renderPushPrompt();
});
$('feedback-btn').addEventListener('click', openFeedback);
$('feedback-cancel').addEventListener('click', closeFeedback);
$('feedback-send').addEventListener('click', sendFeedback);
$('feedback-modal').addEventListener('click', (e) => { if (e.target === $('feedback-modal')) closeFeedback(); });
$('special-save').addEventListener('click', saveSpecialOuting);
$('special-cancel').addEventListener('click', closeSpecialModal);
$('special-modal').addEventListener('click', (e) => { if (e.target === $('special-modal')) closeSpecialModal(); });
$('special-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSpecialOuting(); });
$('diary-btn').addEventListener('click', openDiary);
$('diary-close').addEventListener('click', closeDiary);
$('diary-modal').addEventListener('click', (e) => { if (e.target === $('diary-modal')) closeDiary(); });
$('reset-checks').addEventListener('click', resetChecks);
$('reset-return-checks').addEventListener('click', resetReturnChecks);
$('return-done-btn').addEventListener('click', () => {
    const name = getPersonName();
    showCelebrationOverlay('✅', '確認できました！', `${name ? name + 'さん、' : ''}おつかれさまでした 🍵`, 'text-green-600');
    returnCheckOpen = false;
    applyReturnCheckVisibility();
});
$('reset-all').addEventListener('click', resetAll);
$('share-btn').addEventListener('click', handleShare);
$('line-share-btn').addEventListener('click', handleLineShare);
$('theme-btn').addEventListener('click', handleThemeToggle);
$('print-btn').addEventListener('click', handlePrint);
$('import-ok').addEventListener('click', handleImportOk);
$('import-cancel').addEventListener('click', dismissImport);
$('modal-cancel').addEventListener('click', closeModal);
$('modal-save').addEventListener('click', handleModalSave);
$('modal-item-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleModalSave();
    if (e.key === 'Escape') closeModal();
});
// モーダル外クリックで閉じる
$('add-modal').addEventListener('click', (e) => {
    if (e.target === $('add-modal')) closeModal();
});
$('modal-qty-minus').addEventListener('click', () => {
    if (modalQty > 1) modalQty--;
    $('modal-qty-display').textContent = String(modalQty);
});
$('modal-qty-plus').addEventListener('click', () => {
    if (modalQty < 99) modalQty++;
    $('modal-qty-display').textContent = String(modalQty);
});

// Service Worker 登録
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((e) => {
            console.warn('Service Workerの登録に失敗:', e);
        });
    });
}

startApp();
