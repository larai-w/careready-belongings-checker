// storage.js — IndexedDB永続化レイヤー
// 読み書きはメモリ上のキャッシュに対して同期的に行い、IndexedDBへの保存は非同期で追従させる。
// IndexedDBが使えない環境では localStorage にフォールバックする。

const DB_NAME = 'careready';
const DB_VERSION = 1;
const STORE = 'kv';

// 旧localStorageキー → 新キー の対応(移行用)
const LEGACY_KEYS = {
    careready_checked_items: 'checked',
    careready_skipped_items: 'skipped',
    careready_container_items: 'containers',
};

let db = null;
const cache = {};

// オープンが塞がれたまま(別タブが旧バージョンを掴んでいる等)アプリ全体が
// 「読み込み中」で固まるのを防ぐため、タイムアウトを設けて失敗扱いにする
const OPEN_TIMEOUT_MS = 3000;

function openDB() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            reject(new Error('IndexedDB not supported'));
            return;
        }
        const timer = setTimeout(() => reject(new Error('IndexedDB open timeout')), OPEN_TIMEOUT_MS);
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => {
            clearTimeout(timer);
            resolve(req.result);
        };
        req.onerror = () => {
            clearTimeout(timer);
            reject(req.error);
        };
        req.onblocked = () => {
            clearTimeout(timer);
            reject(new Error('IndexedDB open blocked'));
        };
    });
}

function idbGetAll(database) {
    return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const result = {};
        const req = store.openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                result[cursor.key] = cursor.value;
                cursor.continue();
            } else {
                resolve(result);
            }
        };
        req.onerror = () => reject(req.error);
    });
}

function idbPut(key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
    });
}

function idbDelete(key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
    });
}

// localStorage上のデータをIndexedDBへ引き継ぐ:
// - 旧バージョンのキー(careready_*)
// - IndexedDBが一時的に使えなかったセッションで書かれたキー(careready_v2_*)
async function migrateFromLocalStorage() {
    const pairs = Object.entries(LEGACY_KEYS);
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('careready_v2_')) {
            pairs.push([k, k.slice('careready_v2_'.length)]);
        }
    }
    for (const [srcKey, newKey] of pairs) {
        const raw = localStorage.getItem(srcKey);
        if (raw === null) continue;
        try {
            const parsed = JSON.parse(raw);
            if (cache[newKey] === undefined || JSON.stringify(cache[newKey]) === JSON.stringify(parsed)) {
                cache[newKey] = parsed;
                // 元データを消す前に、書き込みトランザクションの完了を待つ。
                if (db) {
                    await idbPut(newKey, parsed);
                    localStorage.removeItem(srcKey);
                }
            }
            // 保存先と内容が違う場合は、自動で選び直さず移行元も残す。
        } catch { /* 読み取り・保存失敗時も移行元を残し、次回起動で再試行する */ }
    }
}

export async function initStorage() {
    try {
        db = await openDB();
        Object.assign(cache, await idbGetAll(db));
    } catch (e) {
        console.warn('IndexedDBが使えないため localStorage で動作します:', e);
        db = null;
        // フォールバック: localStorageの careready_v2_* から復元
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('careready_v2_')) {
                try {
                    cache[k.slice('careready_v2_'.length)] = JSON.parse(localStorage.getItem(k));
                } catch { /* 壊れたデータは無視 */ }
            }
        }
    }
    await migrateFromLocalStorage();
}

export function getState(key, fallback) {
    return cache[key] !== undefined ? cache[key] : fallback;
}

export function setState(key, value) {
    if (restoreBusy) throw new Error('復元中です。操作をお待ちください。');
    cache[key] = value;
    // 最終更新日時を記録(印刷モード等で使用)
    cache._lastUpdatedAt = new Date().toISOString();
    if (db) {
        trackWrite(idbPut(key, value));
        trackWrite(idbPut('_lastUpdatedAt', cache._lastUpdatedAt));
    } else {
        try {
            localStorage.setItem('careready_v2_' + key, JSON.stringify(value));
            localStorage.setItem('careready_v2__lastUpdatedAt', JSON.stringify(cache._lastUpdatedAt));
        } catch (e) {
            writeFault = true;
            console.error('保存に失敗:', e);
        }
    }
}

// 最終更新日時を取得(印刷モード用)
export function getLastUpdatedAt() {
    return cache._lastUpdatedAt || null;
}

export function removeState(key) {
    if (restoreBusy) throw new Error('復元中です。操作をお待ちください。');
    delete cache[key];
    if (db) {
        trackWrite(idbDelete(key));
    } else {
        localStorage.removeItem('careready_v2_' + key);
    }
}

// 文字サイズ(アクセシビリティ)は、initStorage 完了前のちらつき防止のため
// ページ最初期に同期で読み書きする必要がある。ストレージ層に薄い同期アクセサを置き、
// app.js からは記憶媒体を直接参照させない(実装規約: 保存はstorage.js経由)。
const TEXT_SCALE_KEY = 'careready_textscale';

export function readTextScale() {
    try {
        return localStorage.getItem(TEXT_SCALE_KEY);
    } catch (e) {
        return null;
    }
}

export function writeTextScale(value) {
    try {
        localStorage.setItem(TEXT_SCALE_KEY, value);
    } catch (e) {
        /* noop */
    }
}

// Backup reads durable values, not an optimistic in-memory cache.
const pendingWrites = new Set();
let writeFault = false;
let restoreBusy = false;
function trackWrite(promise) {
    const tracked = promise.catch((error) => { writeFault = true; console.error('保存に失敗:', error); });
    pendingWrites.add(tracked);
    tracked.finally(() => pendingWrites.delete(tracked));
}
async function waitForWrites() {
    await Promise.all([...pendingWrites]);
    if (writeFault) throw new Error('保存に失敗した操作があります。画面の内容を確認してから再読み込みしてください。');
}
export async function readBackupState(keys) {
    await waitForWrites();
    let values;
    if (db) values = await idbGetAll(db);
    else {
        values = {};
        for (const key of keys) {
            const raw = localStorage.getItem('careready_v2_' + key);
            if (raw !== null) values[key] = JSON.parse(raw);
        }
    }
    return Object.fromEntries(keys.filter(k => values[k] !== undefined).map(k => [k, values[k]]));
}
export async function restoreBackupState(data, expected) {
    await waitForWrites();
    if (!db) throw new Error('このブラウザでは一括保存を利用できません。別のブラウザで復元してください。');
    if (restoreBusy) throw new Error('復元中です。しばらくお待ちください。');
    const keys = Object.keys(data);
    restoreBusy = true;
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            let remaining = keys.length;
            let conflict = false;
            tx.oncomplete = resolve;
            tx.onerror = () => reject(new Error('保存できませんでした。元のデータは変更していません。'));
            tx.onabort = () => reject(new Error(conflict ? '別の画面でデータが変わりました。取り消してファイルを選び直してください。' : '保存できませんでした。元のデータは変更していません。'));
            for (const key of keys) {
                const req = store.get(key);
                req.onsuccess = () => {
                    if (JSON.stringify(req.result === undefined ? null : req.result) !== JSON.stringify(expected[key] === undefined ? null : expected[key])) conflict = true;
                    if (--remaining === 0) {
                        if (conflict) { tx.abort(); return; }
                        try {
                            for (const k of keys) store.put(data[k], k);
                            store.put(new Date().toISOString(), '_lastUpdatedAt');
                        } catch { tx.abort(); }
                    }
                };
            }
        });
        for (const key of keys) cache[key] = structuredClone(data[key]);
    } finally { restoreBusy = false; }
}
