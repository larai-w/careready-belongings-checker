// app.js — CareReady メインロジック
import { initStorage, getState, setState, removeState } from './storage.js';

// APIのURL。空文字のままなら同梱の data.json を使用する。
// 例: const API_URL = 'https://veai.jp/api/checklist';
const API_URL = '';

const FETCH_TIMEOUT_MS = 8000;

// コンテナ(箱)の選択肢
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
let viewMode = 'category'; // 'category' または 'container'

const $ = (id) => document.getElementById(id);

// ---------- データ取得 ----------

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
    return data
        && Array.isArray(data.locations) && data.locations.length > 0
        && Array.isArray(data.categories);
}

// 取得戦略: API → 前回キャッシュ → 同梱データ の順で試す
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

function showBanner(source) {
    const banner = $('data-banner');
    if (source === 'cache') {
        banner.textContent = '⚠️ サーバーに接続できないため、前回取得したデータを表示しています';
        banner.className = 'text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-4 text-center';
    } else if (source === 'bundled' && API_URL) {
        banner.textContent = '⚠️ サーバーに接続できないため、標準リストを表示しています';
        banner.className = 'text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-4 text-center';
    } else {
        banner.textContent = '';
        banner.className = 'hidden';
    }
}

async function startApp() {
    await initStorage();
    try {
        const { data, source } = await loadChecklist();
        appData = data;
        showBanner(source);
        currentSubtype = appData.locations[0].id;
        renderTabs();
        renderChecklist();
    } catch (e) {
        console.error('データの取得に失敗しました:', e);
        const tabs = $('location-tabs');
        tabs.textContent = '';
        const msg = document.createElement('p');
        msg.className = 'text-red-400 text-sm';
        msg.textContent = 'データの読み込みに失敗しました。';
        const retry = document.createElement('button');
        retry.className = 'ml-2 text-cyan-400 underline text-sm';
        retry.textContent = '再試行';
        retry.addEventListener('click', () => {
            tabs.textContent = '読み込み中...';
            startApp();
        });
        tabs.appendChild(msg);
        msg.appendChild(retry);
    }
}

// ---------- 表示 ----------

function switchViewMode(mode) {
    viewMode = mode;
    const active = 'flex-1 py-1.5 text-xs font-bold rounded-lg transition-all bg-cyan-500 text-slate-900 shadow';
    const inactive = 'flex-1 py-1.5 text-xs font-bold rounded-lg transition-all text-gray-400 hover:text-gray-200';
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
                ? 'bg-cyan-500 text-slate-900 shadow-lg shadow-cyan-500/20'
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
    const container = $('checklist-container');
    container.textContent = '';

    const checked = getState('checked', {});
    const skipped = getState('skipped', {});
    const containers = getState('containers', {});

    // 現在の場所に該当するアイテムをすべて集める
    const allFilteredItems = [];
    appData.categories.forEach((cat) => {
        (cat.items || []).forEach((item) => {
            if ((item.applicable_locations || []).includes(currentSubtype)) {
                allFilteredItems.push({ ...item, categoryName: cat.name });
            }
        });
    });

    if (viewMode === 'category') {
        // 場所別(カテゴリー別)表示
        appData.categories.forEach((cat) => {
            const filteredItems = (cat.items || []).filter(
                (item) => (item.applicable_locations || []).includes(currentSubtype)
            );
            if (filteredItems.length === 0) return;

            const section = document.createElement('div');
            section.className = 'bg-gray-800/50 border border-gray-700/60 rounded-xl p-4';

            const title = document.createElement('h2');
            title.className = 'text-md font-bold text-cyan-300 mb-3 border-b border-gray-700 pb-1';
            title.textContent = cat.name;
            section.appendChild(title);

            const itemSpace = document.createElement('div');
            itemSpace.className = 'space-y-3';
            filteredItems.forEach((item) => {
                itemSpace.appendChild(createItemRow(item, checked, skipped, containers[item.id] || 'none'));
            });
            section.appendChild(itemSpace);
            container.appendChild(section);
        });
    } else {
        // コンテナ(箱)別ソーティング表示
        CONTAINERS.forEach((box) => {
            const boxItems = allFilteredItems.filter(
                (item) => (containers[item.id] || 'none') === box.id
            );
            if (boxItems.length === 0) return;

            const section = document.createElement('div');
            section.className = 'bg-slate-800/80 border border-dashed border-cyan-500/30 rounded-xl p-4';

            const title = document.createElement('h2');
            title.className = 'text-md font-bold text-amber-400 mb-3 border-b border-gray-700 pb-1 flex justify-between items-center';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = `📦 ${box.name}`;
            const countSpan = document.createElement('span');
            countSpan.className = 'text-xs text-gray-500';
            countSpan.textContent = `計 ${boxItems.length} 点`;
            title.append(nameSpan, countSpan);
            section.appendChild(title);

            const itemSpace = document.createElement('div');
            itemSpace.className = 'space-y-3';
            boxItems.forEach((item) => {
                itemSpace.appendChild(createItemRow(item, checked, skipped, box.id, true));
            });
            section.appendChild(itemSpace);
            container.appendChild(section);
        });
    }

    updateProgress();
}

// アイテム1行分のDOMを生成(textContentベースでXSSを防ぐ)
function createItemRow(item, checked, skipped, currentBox, showCategoryBadge = false) {
    const isSkipped = Boolean(skipped[item.id]);

    const itemRow = document.createElement('div');
    itemRow.className = 'flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2 rounded-lg hover:bg-gray-700/10 transition-colors border-b border-gray-800/40 pb-3 sm:pb-2';

    // 左側: チェックボックス+名前
    const left = document.createElement('div');
    left.className = 'flex items-start gap-3 flex-1';
    const label = document.createElement('label');
    label.className = 'flex items-start gap-3 cursor-pointer flex-1';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(checked[item.id]);
    checkbox.disabled = isSkipped;
    checkbox.className = `w-5 h-5 rounded border-gray-600 bg-gray-700 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-gray-800 mt-0.5 ${isSkipped ? 'opacity-20' : ''}`;
    checkbox.addEventListener('change', () => setChecked(item.id, checkbox.checked));

    const textWrap = document.createElement('div');
    textWrap.className = 'flex flex-col';
    const nameSpan = document.createElement('span');
    nameSpan.className = `${isSkipped ? 'line-through-text' : 'text-gray-300'} text-sm leading-relaxed`;
    nameSpan.textContent = item.name;
    textWrap.appendChild(nameSpan);
    if (showCategoryBadge && item.categoryName) {
        const badge = document.createElement('span');
        badge.className = 'text-[10px] text-gray-500 mt-0.5';
        badge.textContent = item.categoryName;
        textWrap.appendChild(badge);
    }
    label.append(checkbox, textWrap);
    left.appendChild(label);

    // 右側: 箱セレクト+不要ボタン
    const right = document.createElement('div');
    right.className = 'flex items-center gap-2 self-end sm:self-center';

    const select = document.createElement('select');
    select.disabled = isSkipped;
    select.className = 'text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-cyan-400 focus:ring-cyan-500 focus:border-cyan-500 disabled:opacity-20';
    CONTAINERS.forEach((b) => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.name;
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
    itemRow.append(left, right);
    return itemRow;
}

// ---------- 状態変更 ----------

function setChecked(itemId, isChecked) {
    const checked = getState('checked', {});
    if (isChecked) {
        checked[itemId] = true;
    } else {
        delete checked[itemId];
    }
    setState('checked', checked);
    updateProgress();
}

function setContainer(itemId, boxId) {
    const containers = getState('containers', {});
    if (boxId === 'none') {
        delete containers[itemId];
    } else {
        containers[itemId] = boxId;
    }
    setState('containers', containers);
    // コンテナモードではリアルタイムに並び替える
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

function updateProgress() {
    const activeCheckboxes = document.querySelectorAll('input[type="checkbox"]:not([disabled])');
    const checkedBoxes = document.querySelectorAll('input[type="checkbox"]:not([disabled]):checked');

    const total = activeCheckboxes.length;
    const done = checkedBoxes.length;

    $('progress-text').textContent = `${done} / ${total} 個`;
    $('progress-bar').style.width = total > 0 ? `${(done / total) * 100}%` : '0%';
}

// チェックのみリセット(箱の割り当て・不要設定は次回も使い回せるよう保持する)
function resetChecks() {
    if (confirm('チェックをリセットしますか?\n(箱の割り当てと「不要」の設定は保持されます)')) {
        setState('checked', {});
        renderChecklist();
    }
}

// すべてのデータを削除
function resetAll() {
    if (confirm('チェック・不要設定・箱の割り当てをすべて削除しますか?\nこの操作は元に戻せません。')) {
        removeState('checked');
        removeState('skipped');
        removeState('containers');
        renderChecklist();
    }
}

// ---------- 起動 ----------

$('mode-category').addEventListener('click', () => switchViewMode('category'));
$('mode-container').addEventListener('click', () => switchViewMode('container'));
$('reset-checks').addEventListener('click', resetChecks);
$('reset-all').addEventListener('click', resetAll);

startApp();

// Service Worker 登録(オフライン対応)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((e) => {
            console.warn('Service Workerの登録に失敗:', e);
        });
    });
}
