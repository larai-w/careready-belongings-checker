// app.js — CareReady メインロジック
import { initStorage, getState, setState, removeState } from './storage.js';

// APIのURL。空文字のままなら同梱の data.json を使用する。
// 例: const API_URL = 'https://veai.jp/api/checklist';
const API_URL = '';

// バックエンドAPIベースURL (B-3 施設テンプレ)
const API_BASE = 'https://6r6n0fjn4d.execute-api.ap-northeast-1.amazonaws.com';

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
        renderChecklist();
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

function handleLineShare() {
    const url = generateShareURL();
    const text = url + '\nCareReadyで持ち物リストを共有します';
    window.open('https://line.me/R/share?text=' + encodeURIComponent(text), '_blank', 'noopener');
}

// ---------- Theme ----------

function applyTheme(isLight) {
    if (isLight) {
        document.body.classList.add('light');
        document.querySelector('meta[name="theme-color"]').setAttribute('content', '#faf6f0');
        $('theme-btn').textContent = '☀️ ライト';
    } else {
        document.body.classList.remove('light');
        document.querySelector('meta[name="theme-color"]').setAttribute('content', '#121824');
        $('theme-btn').textContent = '🌙 ダーク';
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

    // 行き先チェックボックスを生成 (デフォルト全選択)
    const locWrap = $('modal-locations');
    locWrap.textContent = '';
    appData.locations.forEach((loc) => {
        const label = document.createElement('label');
        label.className =
            'flex items-center gap-1.5 text-sm text-gray-300 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 cursor-pointer hover:border-teal-500 transition-colors';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = loc.id;
        cb.checked = true;
        cb.className = 'accent-teal-500';
        const span = document.createElement('span');
        span.textContent = loc.name;
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

    const returnBtn = $('mode-return');
    const viewModeToggle = $('view-mode-toggle');
    const progressSection = $('progress-section');
    const progressBarWrap = $('progress-bar-wrap');
    const returnProgressSection = $('return-progress-section');

    if (returnMode) {
        // 帰宅チェックモードON
        returnBtn.className =
            'text-xs bg-green-500 text-slate-900 font-bold rounded-xl px-4 py-1.5 transition-colors shadow';
        returnBtn.textContent = '🏠 帰宅チェックモード (ON)';
        viewModeToggle.classList.add('opacity-40', 'pointer-events-none');
        progressSection.classList.add('hidden');
        progressBarWrap.classList.add('hidden');
        returnProgressSection.classList.remove('hidden');
    } else {
        // 準備モードに戻る
        returnBtn.className =
            'text-xs bg-gray-800 border border-gray-700 text-gray-400 hover:text-green-400 hover:border-green-500/60 rounded-xl px-4 py-1.5 transition-colors font-bold';
        returnBtn.textContent = '🏠 帰宅チェックモード';
        viewModeToggle.classList.remove('opacity-40', 'pointer-events-none');
        progressSection.classList.remove('hidden');
        progressBarWrap.classList.remove('hidden');
        returnProgressSection.classList.add('hidden');
    }

    renderChecklist();
}

// ---------- Render ----------

function switchViewMode(mode) {
    viewMode = mode;
    const active =
        'flex-1 py-1.5 text-xs font-bold rounded-lg transition-all bg-teal-500 text-slate-900 shadow';
    const inactive =
        'flex-1 py-1.5 text-xs font-bold rounded-lg transition-all text-gray-400 hover:text-gray-200';
    $('mode-category').className = mode === 'category' ? active : inactive;
    $('mode-container').className = mode === 'container' ? active : inactive;
    renderChecklist();
}

function renderTabs() {
    const tabsContainer = $('location-tabs');
    tabsContainer.textContent = '';
    appData.locations.forEach((loc) => {
        const button = document.createElement('button');
        button.textContent = loc.name;
        button.className = `px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
            currentSubtype === loc.id
                ? 'bg-teal-500 text-slate-900 shadow-lg shadow-teal-500/20'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
        }`;
        button.addEventListener('click', () => {
            currentSubtype = loc.id;
            renderTabs();
            renderChecklist();
        });
        tabsContainer.appendChild(button);
    });
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
    const skipped = getState('skipped', {});
    const containers = getState('containers', {});
    const customItems = getCustomItems();

    // 3層マージ: 施設テンプレのhideセットと追加アイテム
    const hideSet = getFacilityHideSet();
    const facilityItemsByCategory = getFacilityItemsByCategory();

    if (viewMode === 'category') {
        // 通常カテゴリを処理
        appData.categories.forEach((cat) => {
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

            const section = document.createElement('div');
            section.className = 'bg-gray-800/50 border border-gray-700/60 rounded-xl p-4';

            // タイトル行 + 追加ボタン
            const titleRow = document.createElement('div');
            titleRow.className = 'flex items-center justify-between mb-3 border-b border-gray-700 pb-1';
            const title = document.createElement('h2');
            title.className = 'text-md font-bold text-teal-300';
            title.textContent = cat.name;
            const addBtn = document.createElement('button');
            addBtn.className =
                'text-[11px] text-teal-500 hover:text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/20 px-2 py-0.5 rounded transition-colors';
            addBtn.textContent = '+ 追加';
            addBtn.addEventListener('click', () => openModal(cat.id));
            titleRow.append(title, addBtn);
            section.appendChild(titleRow);

            const itemSpace = document.createElement('div');
            itemSpace.className = 'space-y-3';
            filteredItems.forEach((item) => {
                itemSpace.appendChild(
                    createItemRow(item, checked, skipped, containers[item.id] || 'none')
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
                    createItemRow(item, checked, skipped, containers[item.id] || 'none')
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

        // ===== 「箱に詰める」モード: 使い方ガイド + いま詰めている箱 + タップで割り当て =====
        const guide = buildPackGuide();
        if (guide) container.appendChild(guide);
        container.appendChild(buildActiveBoxBar());

        const activeBox = getActiveBox();

        // カテゴリ順にグルーピング(「不要」は非表示)
        const groups = [];
        const groupIndex = {};
        allFilteredItems.forEach((item) => {
            if (skipped[item.id]) return;
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

// 箱ごとの色(実物の箱に同色シールを貼れば対応が直感的)
const BOX_PALETTE = [
    { dot: 'bg-teal-500',    badge: 'bg-teal-600',    chipBg: 'bg-teal-600',    chipBorder: 'border-teal-700' },
    { dot: 'bg-sky-500',     badge: 'bg-sky-600',     chipBg: 'bg-sky-600',     chipBorder: 'border-sky-700' },
    { dot: 'bg-amber-500',   badge: 'bg-amber-600',   chipBg: 'bg-amber-600',   chipBorder: 'border-amber-700' },
    { dot: 'bg-rose-500',    badge: 'bg-rose-600',    chipBg: 'bg-rose-600',    chipBorder: 'border-rose-700' },
    { dot: 'bg-violet-500',  badge: 'bg-violet-600',  chipBg: 'bg-violet-600',  chipBorder: 'border-violet-700' },
    { dot: 'bg-emerald-500', badge: 'bg-emerald-600', chipBg: 'bg-emerald-600', chipBorder: 'border-emerald-700' },
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
function packTap(itemId) {
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
    }
    setState('checked', checked);
    setState('containers', containers);
    renderChecklist();
}

// 「箱に詰める」モードの使い方ガイド(開閉式)。閉じた状態は記憶する
function buildPackGuide() {
    if (getState('packGuideDismissed', false)) return null;
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
        setState('packGuideDismissed', true);
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
        setState('packGuideDismissed', false);
        renderChecklist();
    });
    titleRow.append(title, helpBtn);
    card.appendChild(titleRow);

    const chips = document.createElement('div');
    chips.className = 'flex flex-wrap gap-2';
    boxes.forEach((box) => {
        const isActive = box.id === activeBox;
        const color = getBoxColor(box.id);
        const chip = document.createElement('button');
        chip.className = `flex items-center gap-2 min-h-[48px] px-4 rounded-xl font-bold border-2 transition-colors ${
            isActive
                ? `${color.chipBg} text-white ${color.chipBorder} shadow`
                : 'bg-gray-800 text-gray-300 border-gray-700 hover:border-gray-500'
        }`;
        const dot = document.createElement('span');
        dot.className = `w-3 h-3 rounded-full ${isActive ? 'bg-white' : color.dot}`;
        const label = document.createElement('span');
        label.textContent = getContainerName(box.id);
        chip.append(dot, label);
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
        'flex items-center gap-1 min-h-[48px] px-4 rounded-xl font-bold text-teal-400 bg-teal-500/10 border-2 border-dashed border-teal-500/50 hover:bg-teal-500/20 transition-colors';
    addChip.textContent = '＋ 箱を追加';
    addChip.addEventListener('click', addContainer);
    chips.appendChild(addChip);
    card.appendChild(chips);

    // アクティブな箱の 名前変更 / 削除(対象を明示した分かりやすいボタン)
    const activeName = getContainerName(activeBox);
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-2 mt-3';
    const renameBtn = document.createElement('button');
    renameBtn.className =
        'inline-flex items-center gap-1.5 text-xs font-bold text-teal-400 bg-teal-500/10 border border-teal-500/30 hover:bg-teal-500/20 rounded-lg px-3 py-2 transition-colors';
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

    const hint = document.createElement('p');
    hint.className = 'text-sm text-teal-400 mt-3';
    hint.textContent = `👇 下のアイテムをタップすると「${getContainerName(activeBox)}」に入ります`;
    card.appendChild(hint);

    return card;
}

function createPackItemRow(item, checked, currentBox, activeBox) {
    const isChecked = Boolean(checked[item.id]);
    const inBox = Boolean(currentBox) && currentBox !== 'none';
    const color = inBox ? getBoxColor(currentBox) : null;

    const row = document.createElement('button');
    row.className = `w-full flex items-center gap-3 min-h-[56px] px-3 py-2 rounded-xl border transition-colors text-left ${
        isChecked
            ? 'bg-slate-800/70 border-gray-700'
            : 'bg-slate-800/30 border-gray-800/60 hover:bg-slate-800/50'
    }`;

    const mark = document.createElement('span');
    mark.className =
        'w-7 h-7 rounded-lg flex items-center justify-center font-bold shrink-0 ' +
        (isChecked ? `${color ? color.badge : 'bg-teal-600'} text-white` : 'border-2 border-gray-600');
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

    row.addEventListener('click', () => packTap(item.id));
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

    if (allItems.length === 0) {
        const empty = document.createElement('div');
        empty.className =
            'text-center py-10 text-gray-500 bg-gray-800/30 border border-gray-700/40 rounded-xl';
        const emptyMsg = document.createElement('p');
        emptyMsg.className = 'text-sm';
        emptyMsg.textContent = '準備モードでチェックしたアイテムがありません。';
        const hint = document.createElement('p');
        hint.className = 'text-xs mt-1 text-gray-600';
        hint.textContent = '先に準備モードでアイテムにチェックを入れてください。';
        empty.append(emptyMsg, hint);
        container.appendChild(empty);
        updateReturnProgress([], []);
        return;
    }

    // 消耗品と返却品に分類
    const returnableItems = allItems.filter((item) => !item.consumable);
    const consumableItems = allItems.filter((item) => item.consumable);

    // カテゴリ別にグループ化(返却品)
    if (returnableItems.length > 0) {
        const byCategory = {};
        returnableItems.forEach((item) => {
            const key = item.categoryId || item.categoryName || 'その他';
            if (!byCategory[key]) byCategory[key] = { name: item.categoryName || key, items: [] };
            byCategory[key].items.push(item);
        });

        Object.values(byCategory).forEach((group) => {
            const section = document.createElement('div');
            section.className = 'bg-gray-800/50 border border-gray-700/60 rounded-xl p-4';

            const titleRow = document.createElement('div');
            titleRow.className = 'flex items-center mb-3 border-b border-gray-700 pb-1';
            const title = document.createElement('h2');
            title.className = 'text-md font-bold text-green-300';
            title.textContent = group.name;
            titleRow.appendChild(title);
            section.appendChild(titleRow);

            const itemSpace = document.createElement('div');
            itemSpace.className = 'space-y-3';
            group.items.forEach((item) => {
                itemSpace.appendChild(
                    createReturnItemRow(item, returnChecked, containers[item.id] || 'none')
                );
            });
            section.appendChild(itemSpace);
            container.appendChild(section);
        });
    }

    // 消耗品セクション(グレー表示)
    if (consumableItems.length > 0) {
        const consSection = document.createElement('div');
        consSection.className = 'bg-gray-800/20 border border-gray-700/30 rounded-xl p-4 opacity-60';

        const consTitleRow = document.createElement('div');
        consTitleRow.className = 'flex items-center mb-3 border-b border-gray-700/50 pb-1';
        const consTitle = document.createElement('h2');
        consTitle.className = 'text-md font-bold text-gray-500';
        consTitle.textContent = '🗑️ 消耗品(返却不要)';
        consTitleRow.appendChild(consTitle);
        consSection.appendChild(consTitleRow);

        const consItemSpace = document.createElement('div');
        consItemSpace.className = 'space-y-2';
        consumableItems.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'flex items-center gap-3 p-2';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'text-sm text-gray-600';
            nameSpan.textContent = item.name;
            row.appendChild(nameSpan);
            consItemSpace.appendChild(row);
        });
        consSection.appendChild(consItemSpace);
        container.appendChild(consSection);
    }

    updateReturnProgress(returnableItems, returnChecked);
}

function createReturnItemRow(item, returnChecked, currentBox) {
    const isReturned = Boolean(returnChecked[item.id]);
    const qty = item.quantity && item.quantity > 1 ? item.quantity : null;
    const boxId = currentBox !== 'none' ? currentBox : null;

    const itemRow = document.createElement('div');
    itemRow.className =
        'flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2 rounded-lg hover:bg-gray-700/10 transition-colors border-b border-gray-800/40 pb-3 sm:pb-2';

    const left = document.createElement('div');
    left.className = 'flex items-start gap-3 flex-1';
    const label = document.createElement('label');
    label.className = 'flex items-start gap-3 cursor-pointer flex-1';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isReturned;
    checkbox.className =
        'w-5 h-5 rounded border-gray-600 bg-gray-700 text-green-500 focus:ring-green-500 focus:ring-offset-gray-800 mt-0.5 accent-green-500';
    checkbox.addEventListener('change', () => setReturnChecked(item.id, checkbox.checked));

    const textWrap = document.createElement('div');
    textWrap.className = 'flex flex-col';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'flex items-center flex-wrap gap-1.5';
    const nameSpan = document.createElement('span');
    nameSpan.className = `${isReturned ? 'line-through-text' : 'text-gray-300'} text-sm leading-relaxed`;
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

    label.append(checkbox, textWrap);
    left.appendChild(label);
    itemRow.appendChild(left);

    return itemRow;
}

function createItemRow(item, checked, skipped, currentBox, showCategoryBadge = false) {
    const isSkipped = Boolean(skipped[item.id]);
    const qty = item.quantity && item.quantity > 1 ? item.quantity : null;

    const itemRow = document.createElement('div');
    itemRow.className =
        'flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2 rounded-lg hover:bg-gray-700/10 transition-colors border-b border-gray-800/40 pb-3 sm:pb-2';

    // 左: チェックボックス + 名前
    const left = document.createElement('div');
    left.className = 'flex items-start gap-3 flex-1';
    const label = document.createElement('label');
    label.className = 'flex items-start gap-3 cursor-pointer flex-1';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(checked[item.id]);
    checkbox.disabled = isSkipped;
    checkbox.className = `w-5 h-5 rounded border-gray-600 bg-gray-700 text-teal-500 focus:ring-teal-500 focus:ring-offset-gray-800 mt-0.5 ${isSkipped ? 'opacity-20' : ''}`;
    checkbox.addEventListener('change', () => setChecked(item.id, checkbox.checked));

    const textWrap = document.createElement('div');
    textWrap.className = 'flex flex-col';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'flex items-center flex-wrap gap-1.5';
    const nameSpan = document.createElement('span');
    nameSpan.className = `${isSkipped ? 'line-through-text' : 'text-gray-300'} text-sm leading-relaxed`;
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

    label.append(checkbox, textWrap);
    left.appendChild(label);

    // 右: 箱セレクト + 不要ボタン + (カスタムなら削除ボタン)
    const right = document.createElement('div');
    right.className = 'flex items-center gap-2 self-end sm:self-center';

    const select = document.createElement('select');
    select.disabled = isSkipped;
    select.className =
        'text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-teal-400 focus:ring-teal-500 focus:border-teal-500 disabled:opacity-20';
    getAllContainers().forEach((b) => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = getContainerName(b.id);
        opt.selected = currentBox === b.id;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => setContainer(item.id, select.value));

    const skipBtn = document.createElement('button');
    skipBtn.className = `text-xs px-2 py-1 rounded border transition-colors shrink-0 ${
        isSkipped
            ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
            : 'bg-gray-800 text-gray-500 border-gray-700'
    }`;
    skipBtn.textContent = isSkipped ? '使う' : '不要';
    skipBtn.addEventListener('click', () => toggleSkip(item.id));

    right.append(select, skipBtn);

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

function setReturnChecked(itemId, isChecked) {
    const returnChecked = getState('returnChecked', {});
    if (isChecked) returnChecked[itemId] = true;
    else delete returnChecked[itemId];
    setState('returnChecked', returnChecked);

    // チェック状態に応じてアイテム行のテキストスタイルを即座に更新
    const checked = getState('checked', {});
    const allReturnableItems = getReturnableCheckedItems();
    updateReturnProgress(allReturnableItems, returnChecked);
}

function getReturnableCheckedItems() {
    const checked = getState('checked', {});
    const customItems = getCustomItems();
    const hideSet = getFacilityHideSet();
    const items = [];
    appData.categories.forEach((cat) => {
        (cat.items || []).forEach((item) => {
            if (
                (item.applicable_locations || []).includes(currentSubtype) &&
                checked[item.id] &&
                !item.consumable &&
                !hideSet.has(item.id) &&
                isItemVisible(item)
            ) {
                items.push(item);
            }
        });
    });
    customItems.forEach((item) => {
        if (
            (item.applicable_locations || []).includes(currentSubtype) &&
            checked[item.id] &&
            !item.consumable &&
            isItemVisible(item)
        ) {
            items.push(item);
        }
    });
    return items;
}

function setContainer(itemId, boxId) {
    const containers = getState('containers', {});
    if (boxId === 'none') delete containers[itemId];
    else containers[itemId] = boxId;
    setState('containers', containers);
    if (viewMode === 'container') renderChecklist();
}

function toggleSkip(itemId) {
    const skipped = getState('skipped', {});
    const checked = getState('checked', {});
    if (skipped[itemId]) {
        delete skipped[itemId];
    } else {
        skipped[itemId] = true;
        delete checked[itemId];
    }
    setState('skipped', skipped);
    setState('checked', checked);
    renderChecklist();
}

function deleteCustomItem(itemId) {
    setState('customItems', getCustomItems().filter((i) => i.id !== itemId));
    const checked = getState('checked', {});
    const skipped = getState('skipped', {});
    const containers = getState('containers', {});
    delete checked[itemId];
    delete skipped[itemId];
    delete containers[itemId];
    setState('checked', checked);
    setState('skipped', skipped);
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
    const activeCheckboxes = document.querySelectorAll('input[type="checkbox"]:not([disabled])');
    const checkedBoxes = document.querySelectorAll('input[type="checkbox"]:not([disabled]):checked');
    const total = activeCheckboxes.length;
    const done = checkedBoxes.length;
    $('progress-text').textContent = `${done} / ${total} 個`;
    $('progress-bar').style.width = total > 0 ? `${(done / total) * 100}%` : '0%';

    const msgEl = document.getElementById('progress-msg');
    if (msgEl) {
        const remaining = total - done;
        if (total === 0 || remaining > 3) {
            msgEl.textContent = '';
        } else if (remaining === 0) {
            msgEl.textContent = 'すべて準備できました。おつかれさまでした 🌸';
        } else {
            msgEl.textContent = `あと${remaining}つで準備完了です 🌸`;
        }
    }
}

function updateReturnProgress(returnableItems, returnChecked) {
    const total = returnableItems.length;
    const done = returnableItems.filter((item) => returnChecked[item.id]).length;
    $('return-progress-text').textContent = `${done} / ${total} 個`;
    $('return-progress-bar').style.width = total > 0 ? `${(done / total) * 100}%` : '0%';
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
        showToast('帰宅チェックはまだありません');
        return;
    }
    removeState('returnChecked');
    renderChecklist();
    showToast('帰宅チェックをリセットしました', 6000, {
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
        !confirm('チェック・不要設定・箱の割り当て・カスタムアイテムをすべて削除しますか？')
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
        'packGuideDismissed',
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

// ---------- 未返却リストをコピー ----------

async function copyMissingItems() {
    const checked = getState('checked', {});
    const returnChecked = getState('returnChecked', {});
    const containers = getState('containers', {});
    const customItems = getCustomItems();

    const hideSet = getFacilityHideSet();
    const missingItems = [];

    appData.categories.forEach((cat) => {
        (cat.items || []).forEach((item) => {
            if (
                (item.applicable_locations || []).includes(currentSubtype) &&
                checked[item.id] &&
                !item.consumable &&
                !returnChecked[item.id] &&
                !hideSet.has(item.id) &&
                isItemVisible(item)
            ) {
                missingItems.push(item);
            }
        });
    });
    customItems.forEach((item) => {
        if (
            (item.applicable_locations || []).includes(currentSubtype) &&
            checked[item.id] &&
            !item.consumable &&
            !returnChecked[item.id] &&
            isItemVisible(item)
        ) {
            missingItems.push(item);
        }
    });

    if (missingItems.length === 0) {
        showToast('未返却のアイテムはありません ✅');
        return;
    }

    const locationName = (appData.locations.find((l) => l.id === currentSubtype) || {}).name || currentSubtype;
    const lines = missingItems.map((item) => {
        const boxId = containers[item.id];
        if (boxId && boxId !== 'none') {
            return `・${item.name}(${getContainerName(boxId)})`;
        }
        return `・${item.name}`;
    });

    const text =
        `お世話になっております。以下の持ち物が見当たらないため、ご確認をお願いできますでしょうか。\n` +
        lines.join('\n');

    try {
        await navigator.clipboard.writeText(text);
        showToast(`未返却リスト(${missingItems.length}点)をコピーしました 📋`);
    } catch {
        showToast('コピーに失敗しました。', 3000);
    }
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
$('reset-checks').addEventListener('click', resetChecks);
$('reset-return-checks').addEventListener('click', resetReturnChecks);
$('copy-missing-btn').addEventListener('click', copyMissingItems);
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
