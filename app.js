// app.js — CareReady メインロジック
import { initStorage, getState, setState, removeState } from './storage.js';

// APIのURL。空文字のままなら同梱の data.json を使用する。
// 例: const API_URL = 'https://veai.jp/api/checklist';
const API_URL = '';

const FETCH_TIMEOUT_MS = 8000;

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

const $ = (id) => document.getElementById(id);

// ---------- State helpers ----------

function getCustomItems() {
    return getState('customItems', []);
}

function getContainerName(id) {
    const names = getState('containerNames', {});
    const def = CONTAINERS.find((c) => c.id === id);
    return names[id] || (def ? def.name : id);
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

function generateShareURL() {
    const data = {
        customItems: getCustomItems(),
        containerNames: getState('containerNames', {}),
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
        document.querySelector('meta[name="theme-color"]').setAttribute('content', '#f5f7fa');
        $('theme-btn').textContent = '☀️';
    } else {
        document.body.classList.remove('light');
        document.querySelector('meta[name="theme-color"]').setAttribute('content', '#121824');
        $('theme-btn').textContent = '🌙';
    }
}

function handleThemeToggle() {
    const current = getState('theme', 'dark');
    const next = current === 'dark' ? 'light' : 'dark';
    setState('theme', next);
    applyTheme(next === 'light');
}

function restoreTheme() {
    const saved = getState('theme', 'dark');
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
            'flex items-center gap-1.5 text-sm text-gray-300 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 cursor-pointer hover:border-cyan-500 transition-colors';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = loc.id;
        cb.checked = true;
        cb.className = 'accent-cyan-500';
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
        'flex-1 py-1.5 text-xs font-bold rounded-lg transition-all bg-cyan-500 text-slate-900 shadow';
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

    if (viewMode === 'category') {
        appData.categories.forEach((cat) => {
            const officialItems = (cat.items || []).filter((item) =>
                (item.applicable_locations || []).includes(currentSubtype)
            );
            const myCustomItems = customItems.filter(
                (item) =>
                    item.categoryId === cat.id &&
                    (item.applicable_locations || []).includes(currentSubtype)
            );
            const filteredItems = [...officialItems, ...myCustomItems];
            if (filteredItems.length === 0) return;

            const section = document.createElement('div');
            section.className = 'bg-gray-800/50 border border-gray-700/60 rounded-xl p-4';

            // タイトル行 + 追加ボタン
            const titleRow = document.createElement('div');
            titleRow.className = 'flex items-center justify-between mb-3 border-b border-gray-700 pb-1';
            const title = document.createElement('h2');
            title.className = 'text-md font-bold text-cyan-300';
            title.textContent = cat.name;
            const addBtn = document.createElement('button');
            addBtn.className =
                'text-[11px] text-cyan-500 hover:text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 px-2 py-0.5 rounded transition-colors';
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
    } else {
        // コンテナ別ビュー
        const allFilteredItems = [];
        appData.categories.forEach((cat) => {
            (cat.items || []).forEach((item) => {
                if ((item.applicable_locations || []).includes(currentSubtype)) {
                    allFilteredItems.push({ ...item, categoryName: cat.name });
                }
            });
        });
        customItems.forEach((item) => {
            if ((item.applicable_locations || []).includes(currentSubtype)) {
                allFilteredItems.push(item);
            }
        });

        // 未割り当ては常に表示(詰め忘れ防止)
        const unassigned = allFilteredItems.filter(
            (item) => !containers[item.id] || containers[item.id] === 'none'
        );
        if (unassigned.length > 0) {
            container.appendChild(buildContainerSection('none', unassigned, checked, skipped, containers));
        }

        CONTAINERS.slice(1).forEach((box) => {
            const boxItems = allFilteredItems.filter((item) => containers[item.id] === box.id);
            if (boxItems.length === 0) return;
            container.appendChild(buildContainerSection(box.id, boxItems, checked, skipped, containers));
        });
    }

    updateProgress();
}

function renderReturnChecklist() {
    const container = $('checklist-container');
    container.textContent = '';

    const checked = getState('checked', {});
    const returnChecked = getState('returnChecked', {});
    const containers = getState('containers', {});
    const customItems = getCustomItems();

    // 準備時にチェック済みのアイテムのみ対象
    const allItems = [];
    appData.categories.forEach((cat) => {
        (cat.items || []).forEach((item) => {
            if (
                (item.applicable_locations || []).includes(currentSubtype) &&
                checked[item.id]
            ) {
                allItems.push({ ...item, categoryName: cat.name });
            }
        });
    });
    customItems.forEach((item) => {
        if (
            (item.applicable_locations || []).includes(currentSubtype) &&
            checked[item.id]
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

function buildContainerSection(boxId, items, checked, skipped, containers) {
    const isUnassigned = boxId === 'none';
    const section = document.createElement('div');
    section.className = isUnassigned
        ? 'bg-slate-800/60 border border-gray-700/60 rounded-xl p-4'
        : 'bg-slate-800/80 border border-dashed border-cyan-500/30 rounded-xl p-4';

    const titleRow = document.createElement('div');
    titleRow.className = 'flex items-center justify-between mb-3 border-b border-gray-700 pb-1';

    const nameSpan = document.createElement('span');
    nameSpan.className = `text-md font-bold ${isUnassigned ? 'text-gray-400' : 'text-amber-400'}`;
    nameSpan.textContent = isUnassigned ? '📦 未割り当て' : `📦 ${getContainerName(boxId)}`;

    const rightWrap = document.createElement('div');
    rightWrap.className = 'flex items-center gap-2';
    const countSpan = document.createElement('span');
    countSpan.className = 'text-xs text-gray-500';
    countSpan.textContent = `計 ${items.length} 点`;
    rightWrap.appendChild(countSpan);

    if (!isUnassigned) {
        const renameBtn = document.createElement('button');
        renameBtn.className = 'text-[11px] text-gray-500 hover:text-cyan-400 transition-colors px-1';
        renameBtn.textContent = '✏️ 名前変更';
        renameBtn.addEventListener('click', () => renameContainer(boxId));
        rightWrap.appendChild(renameBtn);
    }

    titleRow.append(nameSpan, rightWrap);
    section.appendChild(titleRow);

    const itemSpace = document.createElement('div');
    itemSpace.className = 'space-y-3';
    items.forEach((item) => {
        itemSpace.appendChild(
            createItemRow(item, checked, skipped, containers[item.id] || 'none', true)
        );
    });
    section.appendChild(itemSpace);
    return section;
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
    checkbox.className = `w-5 h-5 rounded border-gray-600 bg-gray-700 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-gray-800 mt-0.5 ${isSkipped ? 'opacity-20' : ''}`;
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
        customBadge.className = 'text-[9px] text-cyan-600 border border-cyan-700/40 px-1 py-0.5 rounded';
        customBadge.textContent = 'カスタム';
        nameWrap.appendChild(customBadge);
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
        'text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-cyan-400 focus:ring-cyan-500 focus:border-cyan-500 disabled:opacity-20';
    CONTAINERS.forEach((b) => {
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
    const items = [];
    appData.categories.forEach((cat) => {
        (cat.items || []).forEach((item) => {
            if (
                (item.applicable_locations || []).includes(currentSubtype) &&
                checked[item.id] &&
                !item.consumable
            ) {
                items.push(item);
            }
        });
    });
    customItems.forEach((item) => {
        if (
            (item.applicable_locations || []).includes(currentSubtype) &&
            checked[item.id] &&
            !item.consumable
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

function renameContainer(containerId) {
    const current = getContainerName(containerId);
    const newName = prompt('コンテナ名を変更:', current);
    if (newName === null) return;
    const names = getState('containerNames', {});
    const trimmed = newName.trim().slice(0, 20);
    const def = CONTAINERS.find((c) => c.id === containerId);
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
}

function updateReturnProgress(returnableItems, returnChecked) {
    const total = returnableItems.length;
    const done = returnableItems.filter((item) => returnChecked[item.id]).length;
    $('return-progress-text').textContent = `${done} / ${total} 個`;
    $('return-progress-bar').style.width = total > 0 ? `${(done / total) * 100}%` : '0%';
}

function resetChecks() {
    if (confirm('チェックをリセットしますか？\n(箱の割り当てと「不要」の設定は保持されます)')) {
        setState('checked', {});
        renderChecklist();
    }
}

function resetReturnChecks() {
    if (confirm('帰宅チェックをリセットしますか？')) {
        removeState('returnChecked');
        renderChecklist();
    }
}

function resetAll() {
    if (
        confirm(
            'チェック・不要設定・箱の割り当て・カスタムアイテムをすべて削除しますか？\nこの操作は元に戻せません。'
        )
    ) {
        removeState('checked');
        removeState('skipped');
        removeState('containers');
        removeState('customItems');
        removeState('containerNames');
        removeState('returnChecked');
        renderChecklist();
    }
}

// ---------- 未返却リストをコピー ----------

async function copyMissingItems() {
    const checked = getState('checked', {});
    const returnChecked = getState('returnChecked', {});
    const containers = getState('containers', {});
    const customItems = getCustomItems();

    const missingItems = [];

    appData.categories.forEach((cat) => {
        (cat.items || []).forEach((item) => {
            if (
                (item.applicable_locations || []).includes(currentSubtype) &&
                checked[item.id] &&
                !item.consumable &&
                !returnChecked[item.id]
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
            !returnChecked[item.id]
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

    // カテゴリ別にアイテムを出力(スキップ済みは除く)
    appData.categories.forEach((cat) => {
        const officialItems = (cat.items || []).filter(
            (item) =>
                (item.applicable_locations || []).includes(currentSubtype) &&
                !skipped[item.id]
        );
        const myCustomItems = customItems.filter(
            (item) =>
                item.categoryId === cat.id &&
                (item.applicable_locations || []).includes(currentSubtype) &&
                !skipped[item.id]
        );
        const filteredItems = [...officialItems, ...myCustomItems];
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

function showToast(message, duration = 2500) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className =
            'fixed bottom-8 left-1/2 -translate-x-1/2 bg-gray-700 border border-gray-600 text-gray-200 text-sm px-4 py-2.5 rounded-xl shadow-xl z-50 max-w-xs text-center transition-opacity duration-300';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.style.opacity = '0';
    }, duration);
}

// ---------- Event wiring ----------

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
