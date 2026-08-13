// lib/admin-template.js
// 施設管理画面(admin/)で使う純粋関数群。DOM・fetch・Cognito に依存しないため
// node --test で単体テスト可能。admin/admin.js が ES Module として import する。
// 規約: 動的テキストは呼び出し側が createElement+textContent で描画する(本モジュールは
// 文字列/オブジェクトのみを返し、HTML は一切生成しない)。

/**
 * epoch 秒を "YYYY/MM/DD HH:mm" 形式に整形する。
 * 不正値・空値は "" を返す(一覧表示で "-" に置き換えられる想定)。
 * @param {number|string} epochSeconds
 * @returns {string}
 */
export function fmtDate(epochSeconds) {
  if (!epochSeconds) return "";
  const d = new Date(Number(epochSeconds) * 1000);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "/" + p(d.getMonth() + 1) + "/" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/**
 * Cognito InitiateAuth のエラーレスポンスから、利用者向け日本語メッセージを作る。
 * @param {{__type?: string}} data API が返した JSON
 * @returns {string}
 */
export function mapLoginError(data) {
  const type = ((data && data.__type) || "").split("#").pop();
  if (type === "NotAuthorizedException") return "メールアドレスまたはパスワードが違います。";
  if (type === "UserNotFoundException") return "アカウントが見つかりません。";
  if (type === "PasswordResetRequiredException") return "パスワードの再設定が必要です。管理者にお問い合わせください。";
  return "ログインに失敗しました。";
}

/**
 * 共有コードから家族側プレビュー URL を組み立てる。
 * @param {string} baseUrl 例: "https://veai.jp/ready/"
 * @param {string} code 6文字の共有コード
 * @returns {string}
 */
export function shareUrlFor(baseUrl, code) {
  return baseUrl + "?fc=" + encodeURIComponent(code || "");
}

/**
 * 施設独自アイテム行を正規化する。id が無ければ採番する。
 * @param {{id?: string, name?: string, quantity?: string, applicable_locations?: string[]}} data
 * @param {() => string} genId id 生成関数(注入可能・テストでは固定値を渡す)
 * @returns {{id: string, name: string, quantity: string, locations: Set<string>}}
 */
export function normalizeFacRow(data, genId) {
  const d = data || {};
  return {
    id: d.id || (typeof genId === "function" ? genId() : ""),
    name: d.name || "",
    quantity: d.quantity || "",
    locations: new Set(d.applicable_locations || [])
  };
}

/**
 * テンプレ保存用のペイロードを組み立てる。
 * 空の持ち物名は除外し、任意フィールドは空ならキー自体を省く(バックエンド契約に合わせる)。
 * @param {{name: string, facilityName?: string, facilityPhone?: string, facilityAddress?: string, note?: string}} fields
 * @param {Array<{id: string, name: string, quantity: string, locations: Set<string>|string[]}>} facRows
 * @param {string[]} hiddenIds 持込不可(非表示)にする標準アイテム id の一覧
 * @returns {{name: string, items: Array, overrides: {hide: string[], note?: string}, facilityName?: string, facilityPhone?: string, facilityAddress?: string}}
 */
export function buildTemplatePayload(fields, facRows, hiddenIds) {
  const f = fields || {};
  const name = (f.name || "").trim();
  const facilityName = (f.facilityName || "").trim();
  const facilityPhone = (f.facilityPhone || "").trim();
  const facilityAddress = (f.facilityAddress || "").trim();
  const note = (f.note || "").trim();

  const items = [];
  for (const r of facRows || []) {
    const n = (r.name || "").trim();
    if (!n) continue;
    const locs = r.locations instanceof Set ? Array.from(r.locations) : (r.locations || []);
    items.push({
      id: r.id,
      name: n,
      quantity: (r.quantity || "").trim(),
      applicable_locations: locs
    });
  }

  const overrides = { hide: (hiddenIds || []).slice() };
  if (note) overrides.note = note;

  const payload = { name: name, items: items, overrides: overrides };
  if (facilityName) payload.facilityName = facilityName;
  if (facilityPhone) payload.facilityPhone = facilityPhone;
  if (facilityAddress) payload.facilityAddress = facilityAddress;
  return payload;
}