// Versioned preparation backup. Deliberately excludes diary/photos, personal notes and notifications.
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
export const BACKUP_DEFAULTS = {
    checked: {}, returnChecked: {}, skipped: {}, containers: {}, containerNames: {},
    customItems: [], customContainers: [], conditions: {}, sealedBoxes: {},
    specialOutings: [], locationDates: {}, activeBox: null, viewMode: 'category', facilityTemplate: null,
};
export const BACKUP_KEYS = Object.keys(BACKUP_DEFAULTS);
const badKeys = new Set(['__proto__', 'prototype', 'constructor']);
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x, max = 10000) => typeof x === 'string' && x.length <= max;
const id = (x) => text(x, 200) && x.length > 0 && !badKeys.has(x);
function requireValue(ok) { if (!ok) throw new Error('バックアップの形式が正しくありません。'); }
function safeTree(x, depth = 0) {
    requireValue(depth < 12);
    if (x === null || typeof x === 'boolean') return;
    if (typeof x === 'number') { requireValue(Number.isFinite(x)); return; }
    if (typeof x === 'string') { requireValue(text(x)); return; }
    requireValue(typeof x === 'object');
    requireValue(Object.keys(x).length <= 5000);
    for (const [key, value] of Object.entries(x)) {
        requireValue(!badKeys.has(key)); safeTree(value, depth + 1);
    }
}
function map(x, predicate) {
    requireValue(record(x));
    for (const [key, value] of Object.entries(x)) requireValue(id(key) && predicate(value));
}
function namedList(list, items = false) {
    requireValue(Array.isArray(list) && list.length <= 2000);
    const seen = new Set();
    for (const value of list) {
        requireValue(record(value) && id(value.id) && text(value.name, 500) && !seen.has(value.id));
        seen.add(value.id);
        if (items) {
            if (value.categoryId !== undefined) requireValue(id(value.categoryId));
            if (value.categoryName !== undefined) requireValue(text(value.categoryName, 500));
            if (value.applicable_locations !== undefined) requireValue(Array.isArray(value.applicable_locations) && value.applicable_locations.every(id));
            if (value.quantity !== undefined) requireValue(Number.isInteger(value.quantity) && value.quantity >= 0 && value.quantity <= 10000);
            if (value.condition !== undefined && value.condition !== null) requireValue(id(value.condition));
            for (const key of ['myItem', 'personalItem', 'isCustom', 'consumable']) if (value[key] !== undefined) requireValue(typeof value[key] === 'boolean');
        }
    }
}
export function validateBackupData(data) {
    requireValue(record(data) && Object.keys(data).length === BACKUP_KEYS.length && BACKUP_KEYS.every(k => Object.hasOwn(data, k)));
    safeTree(data);
    for (const key of ['checked', 'returnChecked', 'skipped', 'conditions', 'sealedBoxes']) map(data[key], v => typeof v === 'boolean');
    for (const key of ['containers']) map(data[key], id);
    for (const key of ['containerNames', 'locationDates']) map(data[key], v => text(v, 500));
    namedList(data.customItems, true); namedList(data.customContainers); namedList(data.specialOutings);
    for (const outing of data.specialOutings) requireValue(outing.date === undefined || text(outing.date, 30));
    requireValue(data.activeBox === null || id(data.activeBox));
    requireValue(['category', 'container'].includes(data.viewMode));
    if (data.facilityTemplate !== null) {
        const f = data.facilityTemplate;
        requireValue(record(f)); namedList(f.items || [], true);
        for (const key of ['code','name','facilityName','facilityPhone','facilityAddress','shareCode','redeemedAt']) if (f[key] !== undefined) requireValue(text(f[key], 1000));
        if (f.overrides !== undefined) {
            requireValue(record(f.overrides));
            if (f.overrides.hide !== undefined) requireValue(Array.isArray(f.overrides.hide) && f.overrides.hide.every(id));
        }
    }
    return data;
}
export function makeBackup(state, now = new Date().toISOString()) {
    const data = Object.fromEntries(BACKUP_KEYS.map(k => [k, structuredClone(state[k] === undefined ? BACKUP_DEFAULTS[k] : state[k])]));
    validateBackupData(data);
    const backup = { app: 'CareReady', version: 1, createdAt: now, data };
    requireValue(new TextEncoder().encode(JSON.stringify(backup)).length <= MAX_BACKUP_BYTES);
    return backup;
}
export function parseBackup(raw) {
    requireValue(typeof raw === 'string' && new TextEncoder().encode(raw).length <= MAX_BACKUP_BYTES);
    let backup;
    try { backup = JSON.parse(raw); } catch { throw new Error('ファイルを読み込めませんでした。CareReadyのバックアップを選んでください。'); }
    requireValue(record(backup) && backup.app === 'CareReady');
    if (backup.version !== 1) throw new Error('この版のバックアップには対応していません。');
    requireValue(text(backup.createdAt, 50) && Number.isFinite(Date.parse(backup.createdAt)));
    validateBackupData(backup.data);
    return backup;
}
export function backupSummary(data) {
    return `独自の持ち物 ${data.customItems.length}件、独自の入れ物 ${data.customContainers.length}件、準備チェック ${Object.values(data.checked).filter(Boolean).length}件、帰宅チェック ${Object.values(data.returnChecked).filter(Boolean).length}件`;
}
