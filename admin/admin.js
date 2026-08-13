/* CareReady 施設管理画面 (設計書 ステップ B-2)
 *
 * ES Module。DOM 生成は createElement + textContent のみを用い、
 * ユーザー由来テキストを innerHTML に流し込まない(XSS 対策)。
 * 純粋ロジック(日付整形・エラー文言・ペイロード構築等)は lib/admin-template.js
 * に分離し、node --test で単体テストしている。
 */
import {
  fmtDate,
  mapLoginError,
  shareUrlFor as buildShareUrl,
  normalizeFacRow,
  buildTemplatePayload
} from "../lib/admin-template.js";

// ---- 定数 -------------------------------------------------------------
  var API_BASE = "https://6r6n0fjn4d.execute-api.ap-northeast-1.amazonaws.com";
  var COGNITO_ENDPOINT = "https://cognito-idp.ap-northeast-1.amazonaws.com/";
  var COGNITO_CLIENT_ID = "3l4qskvaoqeso5ofcvi35t6bqp";
  var SHARE_BASE_URL = "https://veai.jp/ready/";
  var TOKEN_KEY = "cr_admin_idtoken";
  var EMAIL_KEY = "cr_admin_email";

  // ---- 状態 -------------------------------------------------------------
  var state = {
    idToken: null,
    email: null,
    catalog: null, // data.json の中身
    editingTplId: null, // 編集中のテンプレ ID (新規は null)
    facRows: [] // { id, name, quantity, locations:Set }
  };

  // ---- DOM ショートカット ----------------------------------------------
  function $(id) { return document.getElementById(id); }

  function show(sectionId) {
    ["loginView", "listView", "editView", "shareView"].forEach(function (v) {
      $(v).classList.toggle("hidden", v !== sectionId);
    });
    $("appHeader").classList.toggle("hidden", sectionId === "loginView");
    window.scrollTo(0, 0);
  }

  function toast(message, isError) {
    var el = $("toast");
    el.textContent = message;
    el.classList.remove("hidden");
    el.style.borderColor = isError ? "#7f1d1d" : "#1e2b45";
    el.style.color = isError ? "#fca5a5" : "#e5e7eb";
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.add("hidden"); }, 3500);
  }

  // ---- ヘルプツールチップ -------------------------------------------------
  function initHelpTips() {
    document.querySelectorAll(".help-tip").forEach(function (el) {
      var tipText = el.getAttribute("data-help") || "";
      if (!tipText) return;

      // tooltip 要素を作成
      var tip = document.createElement("span");
      tip.className = "help-tip-tooltip";
      tip.textContent = tipText;
      tip.style.cssText =
        "display:none;position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);" +
        "background:#1e2b45;color:#e5e7eb;font-size:11px;padding:6px 10px;border-radius:6px;" +
        "white-space:nowrap;max-width:280px;white-space:normal;z-index:100;" +
        "border:1px solid #29406b;box-shadow:0 4px 12px rgba(0,0,0,.3);" +
        "font-weight:normal;line-height:1.4;";

      // 親要素を relative に
      var parent = el.parentElement;
      if (parent) parent.style.position = "relative";

      el.style.cssText =
        "display:inline-flex;align-items:center;justify-content:center;" +
        "width:16px;height:16px;border-radius:50%;background:#29406b;color:#94a3b8;" +
        "font-size:10px;font-weight:bold;cursor:help;margin-left:4px;vertical-align:middle;" +
        "transition:background .15s;";

      el.appendChild(tip);

      el.addEventListener("mouseenter", function () { tip.style.display = "block"; });
      el.addEventListener("mouseleave", function () { tip.style.display = "none"; });
      el.addEventListener("focus", function () { tip.style.display = "block"; });
      el.addEventListener("blur", function () { tip.style.display = "none"; });
    });
  }

  // ---- 認証 -------------------------------------------------------------
  function saveSession(idToken, email) {
    state.idToken = idToken;
    state.email = email;
    try {
      sessionStorage.setItem(TOKEN_KEY, idToken);
      sessionStorage.setItem(EMAIL_KEY, email);
    } catch (e) { /* private mode 等は無視、メモリ保持で継続 */ }
  }

  function clearSession() {
    state.idToken = null;
    state.email = null;
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(EMAIL_KEY);
    } catch (e) { /* noop */ }
  }

  function restoreSession() {
    try {
      var t = sessionStorage.getItem(TOKEN_KEY);
      var e = sessionStorage.getItem(EMAIL_KEY);
      if (t) { state.idToken = t; state.email = e; return true; }
    } catch (e) { /* noop */ }
    return false;
  }

  function login(email, password) {
    return fetch(COGNITO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth"
      },
      body: JSON.stringify({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: { USERNAME: email, PASSWORD: password }
      })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error(mapLoginError(data));
        }
        if (data.ChallengeName) {
          throw new Error("初回ログインのため追加手続きが必要です。管理者にお問い合わせください。");
        }
        var auth = data.AuthenticationResult;
        if (!auth || !auth.IdToken) throw new Error("認証情報を取得できませんでした。");
        return auth.IdToken;
      });
    });
  }

  // トークン期限切れ(401)を検知したときの共通処理。
  // Cognito の IdToken は既定 1 時間で失効する。SDK 無し構成では
  // サイレントリフレッシュを行わず、401 を受けた時点で再ログインへ誘導する
  // (RefreshToken を保持しない = 盗まれても被害が 1 時間に限定される)。
  function handleAuthExpired() {
    clearSession();
    show("loginView");
    var err = $("loginError");
    err.textContent = "セッションの有効期限が切れました。もう一度ログインしてください。";
    err.classList.remove("hidden");
  }

  // ---- API 呼び出し -----------------------------------------------------
  function apiFetch(path, options) {
    options = options || {};
    var headers = Object.assign(
      { authorization: state.idToken || "" },
      options.headers || {}
    );
    if (options.body) headers["Content-Type"] = "application/json";
    return fetch(API_BASE + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        handleAuthExpired();
        throw new Error("__AUTH_EXPIRED__");
      }
      if (res.status === 204) return null;
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error((data && data.error) || ("エラーが発生しました (" + res.status + ")"));
        }
        return data;
      });
    });
  }

  // ---- カタログ (data.json) --------------------------------------------
  function loadCatalog() {
    if (state.catalog) return Promise.resolve(state.catalog);
    return fetch("../data.json").then(function (r) {
      if (!r.ok) throw new Error("標準リストを読み込めませんでした。");
      return r.json();
    }).then(function (data) { state.catalog = data; return data; });
  }

  function locationName(id) {
    var locs = (state.catalog && state.catalog.locations) || [];
    for (var i = 0; i < locs.length; i++) if (locs[i].id === id) return locs[i].name;
    return id;
  }

  // ---- テンプレ一覧 -----------------------------------------------------
  // fmtDate は lib/admin-template.js から import

  function renderList(templates) {
    var container = $("tplList");
    container.textContent = "";
    $("listLoading").classList.add("hidden");
    $("listEmpty").classList.toggle("hidden", templates.length > 0);

    templates.forEach(function (tpl) {
      var card = document.createElement("div");
      card.className = "cr-card rounded-xl p-5 flex items-center justify-between gap-4";

      var left = document.createElement("div");
      left.className = "min-w-0";
      var nameEl = document.createElement("div");
      nameEl.className = "font-bold truncate";
      nameEl.textContent = tpl.name || "(名称未設定)";
      var meta = document.createElement("div");
      meta.className = "text-slate-400 text-sm mt-1 flex flex-wrap gap-x-4";

      var codeSpan = document.createElement("span");
      var codeLabel = document.createElement("span");
      codeLabel.textContent = "共有コード: ";
      var codeVal = document.createElement("span");
      codeVal.className = "font-mono text-cyan-400";
      codeVal.textContent = tpl.shareCode || "-";
      codeSpan.appendChild(codeLabel);
      codeSpan.appendChild(codeVal);

      var dateSpan = document.createElement("span");
      dateSpan.textContent = "更新: " + (fmtDate(tpl.updatedAt) || "-");

      meta.appendChild(codeSpan);
      meta.appendChild(dateSpan);
      left.appendChild(nameEl);
      left.appendChild(meta);

      var right = document.createElement("div");
      right.className = "flex items-center gap-2 shrink-0";

      var shareBtn = document.createElement("button");
      shareBtn.className = "cr-btn cr-btn-primary text-sm";
      shareBtn.textContent = "配布";
      shareBtn.addEventListener("click", function () { openShare(tpl); });

      var editBtn = document.createElement("button");
      editBtn.className = "cr-btn cr-btn-ghost text-sm";
      editBtn.textContent = "編集";
      editBtn.addEventListener("click", function () { openEdit(tpl.tplId); });

      var delBtn = document.createElement("button");
      delBtn.className = "cr-btn cr-btn-danger text-sm";
      delBtn.textContent = "削除";
      delBtn.addEventListener("click", function () { deleteTemplate(tpl); });

      right.appendChild(shareBtn);
      right.appendChild(editBtn);
      right.appendChild(delBtn);

      card.appendChild(left);
      card.appendChild(right);
      container.appendChild(card);
    });
  }

  function loadList() {
    show("listView");
    $("listLoading").classList.remove("hidden");
    $("listEmpty").classList.add("hidden");
    $("tplList").textContent = "";
    apiFetch("/v1/facility/templates").then(function (data) {
      renderList((data && data.templates) || []);
    }).catch(function (err) {
      if (err.message === "__AUTH_EXPIRED__") return;
      $("listLoading").classList.add("hidden");
      toast(err.message, true);
    });
  }

  function deleteTemplate(tpl) {
    var ok = window.confirm("「" + (tpl.name || "このリスト") + "」を削除します。\nこの操作は取り消せません。よろしいですか？");
    if (!ok) return;
    apiFetch("/v1/facility/templates/" + encodeURIComponent(tpl.tplId), { method: "DELETE" })
      .then(function () {
        toast("削除しました。");
        loadList();
      }).catch(function (err) {
        if (err.message === "__AUTH_EXPIRED__") return;
        toast(err.message, true);
      });
  }

  // ---- 施設独自アイテム 行 ---------------------------------------------
  function genFacId() {
    var rnd;
    if (window.crypto && window.crypto.getRandomValues) {
      var a = new Uint32Array(2);
      window.crypto.getRandomValues(a);
      rnd = a[0].toString(36) + a[1].toString(36);
    } else {
      rnd = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    return "fac_" + rnd;
  }

  function renderFacRows() {
    var wrap = $("facItems");
    wrap.textContent = "";
    $("facItemsEmpty").classList.toggle("hidden", state.facRows.length > 0);
    $("facItemsHead").classList.toggle("hidden", state.facRows.length === 0);

    var locs = (state.catalog && state.catalog.locations) || [];

    state.facRows.forEach(function (row) {
      var line = document.createElement("div");
      line.className = "grid grid-cols-12 gap-2 items-center";

      var nameCol = document.createElement("div");
      nameCol.className = "col-span-5";
      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "cr-input";
      nameInput.maxLength = 100;
      nameInput.placeholder = "持ち物名";
      nameInput.value = row.name || "";
      nameInput.addEventListener("input", function () { row.name = nameInput.value; });
      nameCol.appendChild(nameInput);

      var qtyCol = document.createElement("div");
      qtyCol.className = "col-span-2";
      var qtyInput = document.createElement("input");
      qtyInput.type = "text";
      qtyInput.className = "cr-input";
      qtyInput.maxLength = 30;
      qtyInput.placeholder = "例: 2枚";
      qtyInput.value = row.quantity || "";
      qtyInput.addEventListener("input", function () { row.quantity = qtyInput.value; });
      qtyCol.appendChild(qtyInput);

      var locCol = document.createElement("div");
      locCol.className = "col-span-4 flex flex-wrap gap-x-3 gap-y-1";
      locs.forEach(function (loc) {
        var lbl = document.createElement("label");
        lbl.className = "flex items-center gap-1 text-sm text-slate-300";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "accent-cyan-500";
        cb.checked = row.locations.has(loc.id);
        cb.addEventListener("change", function () {
          if (cb.checked) row.locations.add(loc.id); else row.locations.delete(loc.id);
        });
        var span = document.createElement("span");
        span.textContent = loc.name;
        lbl.appendChild(cb);
        lbl.appendChild(span);
        locCol.appendChild(lbl);
      });

      var delCol = document.createElement("div");
      delCol.className = "col-span-1 flex justify-end";
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "cr-btn cr-btn-danger text-sm";
      rm.textContent = "×";
      rm.title = "この行を削除";
      rm.addEventListener("click", function () {
        state.facRows = state.facRows.filter(function (r) { return r !== row; });
        renderFacRows();
      });
      delCol.appendChild(rm);

      line.appendChild(nameCol);
      line.appendChild(qtyCol);
      line.appendChild(locCol);
      line.appendChild(delCol);
      wrap.appendChild(line);
    });
  }

  function addFacRow(data) {
    state.facRows.push(normalizeFacRow(data, genFacId));
    renderFacRows();
  }

  // ---- 標準アイテムの持込設定 (overrides.hide) -------------------------
  var hideCheckboxes = {};

  function renderStdItems(hiddenSet) {
    hideCheckboxes = {};
    var wrap = $("stdItems");
    wrap.textContent = "";
    var cats = (state.catalog && state.catalog.categories) || [];

    cats.forEach(function (cat) {
      var block = document.createElement("div");

      var h = document.createElement("h3");
      h.className = "text-cyan-300 font-semibold mb-2";
      h.textContent = cat.name;
      block.appendChild(h);

      var grid = document.createElement("div");
      grid.className = "grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1";

      (cat.items || []).forEach(function (item) {
        var lbl = document.createElement("label");
        lbl.className = "flex items-start gap-2 text-sm text-slate-300 py-0.5";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "accent-cyan-500 mt-1";
        cb.checked = hiddenSet.has(item.id);
        var span = document.createElement("span");
        span.textContent = item.name;
        lbl.appendChild(cb);
        lbl.appendChild(span);
        grid.appendChild(lbl);
        hideCheckboxes[item.id] = cb;
      });

      block.appendChild(grid);
      wrap.appendChild(block);
    });
  }

  function collectHidden() {
    var hide = [];
    Object.keys(hideCheckboxes).forEach(function (id) {
      if (hideCheckboxes[id].checked) hide.push(id);
    });
    return hide;
  }

  // ---- 編集フォーム -----------------------------------------------------
  function resetEditForm() {
    $("tplName").value = "";
    $("tplFacilityName").value = "";
    $("tplFacilityPhone").value = "";
    $("tplFacilityAddress").value = "";
    $("tplNote").value = "";
    state.facRows = [];
    state.editingTplId = null;
  }

  function populateForm(tpl) {
    $("tplName").value = tpl.name || "";
    $("tplFacilityName").value = tpl.facilityName || "";
    $("tplFacilityPhone").value = tpl.facilityPhone || "";
    $("tplFacilityAddress").value = tpl.facilityAddress || "";
    var overrides = tpl.overrides || {};
    $("tplNote").value = overrides.note || "";
    renderStdItems(new Set(overrides.hide || []));

    state.facRows = [];
    (tpl.items || []).forEach(function (it) {
      state.facRows.push(normalizeFacRow(it, genFacId));
    });
    renderFacRows();
  }

  function openEdit(tplId) {
    loadCatalog().then(function () {
      resetEditForm();
      if (!tplId) {
        $("editTitle").textContent = "リストを作成";
        renderStdItems(new Set());
        renderFacRows();
        show("editView");
        return;
      }
      $("editTitle").textContent = "リストを編集";
      show("editView");
      $("saveStatus").textContent = "読み込み中...";
      apiFetch("/v1/facility/templates/" + encodeURIComponent(tplId)).then(function (tpl) {
        state.editingTplId = tpl.tplId;
        populateForm(tpl);
        $("saveStatus").textContent = "";
      }).catch(function (err) {
        if (err.message === "__AUTH_EXPIRED__") return;
        $("saveStatus").textContent = "";
        toast(err.message, true);
        loadList();
      });
    }).catch(function (err) { toast(err.message, true); });
  }

  function buildPayload() {
    // DOM からの値収集のみここで行い、ペイロード構築ロジックは
    // lib/admin-template.js の buildTemplatePayload に委譲する(テスト可能)。
    return buildTemplatePayload(
      {
        name: $("tplName").value,
        facilityName: $("tplFacilityName").value,
        facilityPhone: $("tplFacilityPhone").value,
        facilityAddress: $("tplFacilityAddress").value,
        note: $("tplNote").value
      },
      state.facRows,
      collectHidden()
    );
  }

  function saveTemplate() {
    var payload = buildPayload();
    if (!payload.name) {
      toast("リスト名を入力してください。", true);
      $("tplName").focus();
      return;
    }
    var btn = $("saveTplBtn");
    btn.disabled = true;
    $("saveStatus").textContent = "保存中...";

    var isNew = !state.editingTplId;
    var path = "/v1/facility/templates" + (isNew ? "" : "/" + encodeURIComponent(state.editingTplId));
    var method = isNew ? "POST" : "PUT";

    apiFetch(path, { method: method, body: JSON.stringify(payload) })
      .then(function (tpl) {
        $("saveStatus").textContent = "";
        btn.disabled = false;
        toast("保存しました。");
        openShare(tpl);
      }).catch(function (err) {
        btn.disabled = false;
        $("saveStatus").textContent = "";
        if (err.message === "__AUTH_EXPIRED__") return;
        toast(err.message, true);
      });
  }

  // ---- 配布画面 ---------------------------------------------------------
  // shareUrlFor は lib/admin-template.js から import (buildShareUrl)

  function openShare(tpl) {
    show("shareView");
    $("shareTplName").textContent = tpl.name || "(名称未設定)";
    var code = tpl.shareCode || "";
    $("shareCode").textContent = code || "-";
    var url = buildShareUrl(SHARE_BASE_URL, code);
    $("shareUrl").textContent = url;

    // プレビューボタン用にコードを保持
    $("previewFamilyBtn").dataset.fc = code;
    $("editFromShareBtn").dataset.tplId = tpl.tplId || "";

    var canvas = $("qrCanvas");
    if (window.QRCode && code) {
      window.QRCode.toCanvas(canvas, url, { width: 220, margin: 1 }, function (err) {
        if (err) toast("QRコードの生成に失敗しました。", true);
      });
    }
  }

  function copyShareUrl() {
    var url = $("shareUrl").textContent;
    function done() { toast("URLをコピーしました。"); }
    function fail() { toast("コピーできませんでした。URLを手動で選択してください。", true); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, fail);
    } else {
      try {
        var ta = document.createElement("textarea");
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done();
      } catch (e) { fail(); }
    }
  }

  function openFamilyPreview() {
    var fc = $("previewFamilyBtn").dataset.fc;
    if (!fc) {
      toast("共有コードがありません。", true);
      return;
    }
    var url = buildShareUrl(SHARE_BASE_URL, fc);
    window.open(url, "_blank", "noopener");
  }

  // ---- イベント配線 -----------------------------------------------------
  function wire() {
    $("loginForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var email = $("email").value.trim();
      var pw = $("password").value;
      var err = $("loginError");
      err.classList.add("hidden");
      var btn = $("loginBtn");
      btn.disabled = true;
      btn.textContent = "ログイン中...";
      login(email, pw).then(function (idToken) {
        saveSession(idToken, email);
        $("password").value = "";
        $("userLabel").textContent = email;
        btn.disabled = false;
        btn.textContent = "ログイン";
        loadList();
      }).catch(function (ex) {
        btn.disabled = false;
        btn.textContent = "ログイン";
        err.textContent = ex.message || "ログインに失敗しました。";
        err.classList.remove("hidden");
      });
    });

    $("logoutBtn").addEventListener("click", function () {
      clearSession();
      show("loginView");
      $("email").value = "";
      $("password").value = "";
      $("loginError").classList.add("hidden");
    });

    $("newTplBtn").addEventListener("click", function () { openEdit(null); });
    $("backToListBtn").addEventListener("click", loadList);
    $("cancelEditBtn").addEventListener("click", loadList);
    $("addFacItemBtn").addEventListener("click", function () { addFacRow(); });
    $("saveTplBtn").addEventListener("click", saveTemplate);

    $("shareBackBtn").addEventListener("click", loadList);
    $("copyUrlBtn").addEventListener("click", copyShareUrl);
    $("printBtn").addEventListener("click", function () { window.print(); });
    $("editFromShareBtn").addEventListener("click", function () {
      var id = $("editFromShareBtn").dataset.tplId;
      if (id) openEdit(id);
    });
    $("previewFamilyBtn").addEventListener("click", openFamilyPreview);
  }

  // ---- 起動 -------------------------------------------------------------
  function init() {
    wire();
    initHelpTips(); // ヘルプツールチップ初期化
    if (restoreSession()) {
      $("userLabel").textContent = state.email || "";
      loadList();
    } else {
      show("loginView");
    }
  }

// ES Module は DOM パース後に実行されるため、DOMContentLoaded 待ちは不要だが、
// 安全のため readyState チェックを残す。
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
