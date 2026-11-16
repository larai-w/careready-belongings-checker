// lib/share.js — 共有・インポート/エクスポートの純粋関数群(DOM・storage非依存)
// app.js(ブラウザ)とユニットテスト(node)の両方から import される。
//
// 設計方針:
// - URLパラメータ経由でチェックリスト状態を共有するための encode/decode。
// - btoa/atob はブラウザ・Node 16+の両方で利用可能。
// - escape/unescape は非推奨だが両環境で動作する。将来的には TextEncoder へ移行可。

// 共有データをBase64 URLパラメータ向けにエンコードする。
// 日本語(マルチバイト)を安全に扱うため encodeURIComponent → unescape で Latin1 に変換してから btoa。
export function encodeShareData(data) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}

// Base64文字列をデコードし、共有データオブジェクトを復元する。
// 不正な入力の場合は例外を投げる(呼び出し側でcatch)。
export function decodeShareData(str) {
    return JSON.parse(decodeURIComponent(escape(atob(str.replace(/ /g, '+')))));
}

// URLSearchParams は未エスケープの + を空白にするため、新しいリンクでは必ずエスケープする。
// decodeShareData の空白→+ は過去のリンクとの互換性のため。
export function createShareURL(base, data) {
    return `${base}?t=${encodeURIComponent(encodeShareData(data))}`;
}

// Share outing labels as template metadata, excluding dates and other private state.
export function sharedOutings(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.filter((outing) => {
        if (!outing || typeof outing.id !== 'string' || !/^so_[a-zA-Z0-9_-]+$/.test(outing.id)
            || typeof outing.name !== 'string' || !outing.name.trim() || seen.has(outing.id)) return false;
        seen.add(outing.id);
        return true;
    }).map(({ id, name }) => ({ id, name: name.trim().slice(0, 30) }));
}

// インポートデータとして有効かを検証する。
// 持ち物・入れ物・外出名のいずれかに共有できるデータが必要。
export function isValidShareData(data) {
    if (!data || typeof data !== 'object') return false;
    const hasItems = Array.isArray(data.customItems) && data.customItems.length > 0;
    const hasNames = data.containerNames && typeof data.containerNames === 'object' && Object.keys(data.containerNames).length > 0;
    const hasContainers = Array.isArray(data.customContainers) && data.customContainers.length > 0;
    return hasItems || hasNames || hasContainers || sharedOutings(data.specialOutings).length > 0;
}

// インポート時に既存リストとマージする(重複IDはスキップ)。
// existing: 既存配列、incoming: 取り込み配列。どちらも {id, ...} のオブジェクト配列。
export function mergeById(existing, incoming) {
    const base = Array.isArray(existing) ? existing : [];
    const additions = Array.isArray(incoming) ? incoming : [];
    const existingIds = new Set(base.map((item) => item && item.id).filter(Boolean));
    const toAdd = additions.filter((item) => {
        if (!item || !item.id || existingIds.has(item.id)) return false;
        existingIds.add(item.id);
        return true;
    });
    return [...base, ...toAdd];
}