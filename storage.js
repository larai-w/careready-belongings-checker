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
    });
}

function idbDelete(key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// localStorage上のデータをIndexedDBへ引き継ぐ:
// - 旧バージョンのキー(careready_*)
// - IndexedDBが一時的に使えなかったセッションで書かれたキー(careready_v2_*)
function migrateFromLocalStorage() {
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
            if (cache[newKey] === undefined) {
                const parsed = JSON.parse(raw);
                cache[newKey] = parsed;
                if (db) idbPut(newKey, parsed).catch(() => {});
            }
        } catch { /* 壊れたデータは捨てる */ }
        // IndexedDBが使えている時だけ移行元を消す(フォールバック動作中は残す)
        if (db) localStorage.removeItem(srcKey);
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
    migrateFromLocalStorage();
}

export function getState(key, fallback) {
    return cache[key] !== undefined ? cache[key] : fallback;
}

export function setState(key, value) {
    cache[key] = value;
    // 最終更新日時を記録(印刷モード等で使用)
    cache._lastUpdatedAt = new Date().toISOString();
    if (db) {
        idbPut(key, value).catch((e) => console.error('保存に失敗:', e));
        idbPut('_lastUpdatedAt', cache._lastUpdatedAt).catch(() => {});
    } else {
        try {
            localStorage.setItem('careready_v2_' + key, JSON.stringify(value));
            localStorage.setItem('careready_v2__lastUpdatedAt', JSON.stringify(cache._lastUpdatedAt));
        } catch (e) {
            console.error('保存に失敗:', e);
        }
    }
}

// 最終更新日時を取得(印刷モード用)
export function getLastUpdatedAt() {
    return cache._lastUpdatedAt || null;
}

export function removeState(key) {
    delete cache[key];
    if (db) {
        idbDelete(key).catch(() => {});
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
