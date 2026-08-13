// lib/checklist.js — チェックリストデータ検証・条件表示の純粋関数群(DOM・storage非依存)
// app.js(ブラウザ)とユニットテスト(node)の両方から import される。
//
// 設計方針:
// - data.json / APIレスポンス / キャッシュデータの形式検証。
// - 条件(conditions)によるアイテム表示判定。storageの状態を引数として受け取る。

// data.json / APIレスポンスがチェックリストデータとして有効かを検証する。
// locations(非空配列)とcategories(配列)が必須。
export function isValidData(data) {
    return Boolean(
        data &&
        typeof data === 'object' &&
        Array.isArray(data.locations) &&
        data.locations.length > 0 &&
        Array.isArray(data.categories)
    );
}

// 条件が有効(表示対象)かを判定する。
// conditions: data.json の conditions 配列、savedState: storage の conditions 状態オブジェクト。
// 未定義の条件はデフォルト値を使用。条件自体が存在しない場合は true(表示)。
export function isConditionActive(conditionId, conditions, savedState) {
    if (!Array.isArray(conditions) || conditions.length === 0) return true;
    const cond = conditions.find((c) => c && c.id === conditionId);
    if (!cond) return true;
    const saved = savedState && typeof savedState === 'object' ? savedState : {};
    return saved[conditionId] !== undefined ? saved[conditionId] : cond.default;
}

// アイテムが現在の条件設定で表示すべきか判定する。
// item.condition がなければ常に表示。isConditionActiveFn は条件判定関数(注入可能)。
export function isItemVisible(item, isConditionActiveFn) {
    if (!item || !item.condition) return true;
    return typeof isConditionActiveFn === 'function' ? isConditionActiveFn(item.condition) : true;
}

// 施設テンプレートのhide対象IDセットを返す。
// tpl: facilityTemplate オブジェクト(null可)。
export function getFacilityHideSet(tpl) {
    if (!tpl || !tpl.overrides || !Array.isArray(tpl.overrides.hide)) return new Set();
    return new Set(tpl.overrides.hide);
}

// 施設テンプレートのアイテムをカテゴリIDごとにまとめて返す。
// 戻り値: { categoryId: [item, ...], ... }。categoryId がなければ '__facility__'。
export function getFacilityItemsByCategory(tpl) {
    if (!tpl || !Array.isArray(tpl.items)) return {};
    const result = {};
    for (const item of tpl.items) {
        if (!item || typeof item !== 'object') continue;
        const catId = item.categoryId || '__facility__';
        if (!result[catId]) result[catId] = [];
        result[catId].push({ ...item, isFacility: true });
    }
    return result;
}

// 特別なおでかけIDかどうかを判定する(so_ プレフィックス)。
export function isSpecialOuting(id) {
    return typeof id === 'string' && id.startsWith('so_');
}