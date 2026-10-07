// ==UserScript==
// @name         AnkiBridge for Weblio
// @namespace    ankibridge-for-weblio
// @version      1.0.0
// @description  Weblio学習の単語トレーニング結果から英単語と日本語訳を抽出し、AnkiConnect経由でAnkiに登録します。
// @match        https://weblio-study.weblio.jp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 設定
  // ---------------------------------------------------------------------------

  const DEFAULTS = {
    mode: 'auto', // 'auto' | 'button'
    target: 'all', // 'all' | 'incorrect' | 'correct'
    deckName: 'Weblio',
    modelName: '基本',
    frontField: '表面',
    backField: '裏面',
    tags: 'weblio',
    tagTrainingName: true,
    ankiUrl: 'http://127.0.0.1:8765',
  };

  const MODE_LABELS = { auto: '自動で登録', button: 'ボタンを押して登録' };
  const TARGET_LABELS = { all: '全問', incorrect: '間違えた単語のみ', correct: '正解した単語のみ' };

  function loadSettings() {
    const saved = GM_getValue('settings', {});
    return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  }

  function saveSettings(next) {
    settings = { ...DEFAULTS, ...next };
    GM_setValue('settings', settings);
  }

  let settings = loadSettings();

  // ---------------------------------------------------------------------------
  // AnkiConnect
  // ---------------------------------------------------------------------------

  class AnkiError extends Error {}

  function ankiRequest(action, params = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: settings.ankiUrl,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ action, version: 6, params }),
        timeout: 10000,
        onload: (res) => {
          let body;
          try {
            body = JSON.parse(res.responseText);
          } catch (e) {
            reject(new AnkiError(`AnkiConnectの応答を解釈できません (HTTP ${res.status})`));
            return;
          }
          if (body.error) reject(new AnkiError(`${action}: ${body.error}`));
          else resolve(body.result);
        },
        onerror: () => reject(new AnkiError('AnkiConnectに接続できません。Ankiを起動し、AnkiConnectアドオンが有効か確認してください。')),
        ontimeout: () => reject(new AnkiError('AnkiConnectへの接続がタイムアウトしました。')),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 結果画面からの抽出
  // ---------------------------------------------------------------------------

  const norm = (t) => (t || '').replace(/[\s　]+/g, ' ').trim();
  const hasJapanese = (s) => /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(s);
  const isEnglish = (s) => /[A-Za-z]/.test(s) && !hasJapanese(s);

  function findResultList() {
    const heading = [...document.querySelectorAll('h2')].find((h) => norm(h.textContent) === '出題リスト');
    return heading && heading.parentElement ? { heading, list: heading.parentElement } : null;
  }

  // 行先頭の○/×アイコン: ○ = BsCircle (viewBox 0 0 16 16), × = IoClose (viewBox 0 0 512 512)
  function correctnessFromIcon(row) {
    const svg = row.firstElementChild && row.firstElementChild.querySelector('svg');
    if (!svg) return null;
    const viewBox = svg.getAttribute('viewBox');
    if (viewBox === '0 0 16 16') return true;
    if (viewBox === '0 0 512 512') return false;
    return null;
  }

  function parseRow(row) {
    const o = { question: null, yourAnswer: null, correct: null };
    row.querySelectorAll('dl').forEach((dl) => {
      const dt = norm(dl.querySelector('dt') && dl.querySelector('dt').textContent);
      const dd = norm(dl.querySelector('dd') && dl.querySelector('dd').textContent);
      if (/^Question\s*\d+$/.test(dt)) o.question = dd;
      else if (dt === 'あなたの解答') o.yourAnswer = dd;
      else if (dt === '正解') o.correct = dd;
    });
    o.isCorrect = o.yourAnswer !== null ? o.yourAnswer === o.correct : correctnessFromIcon(row);
    return o;
  }

  // 単語トレーニングの結果なら [{english, japanese, isCorrect}] を、それ以外なら null を返す
  function extractEntries(found) {
    const rows = [...found.list.children].filter((el) => el !== found.heading);
    if (rows.length === 0) return null;

    const parsed = rows.map(parseRow);
    const isWordTraining = parsed.every(
      (p) => p.question && p.correct && p.question.length <= 60
    );
    if (!isWordTraining) return null;

    return parsed.map((p) => {
      // 英→日 / 日→英 どちらの出題でも「英単語 / 日本語訳」に揃える
      const reversed = !isEnglish(p.question) && isEnglish(p.correct);
      return {
        english: reversed ? p.correct : p.question,
        japanese: reversed ? p.question : p.correct,
        isCorrect: p.isCorrect,
      };
    });
  }

  function filterEntries(entries, target) {
    if (target === 'incorrect') return entries.filter((e) => e.isCorrect === false);
    if (target === 'correct') return entries.filter((e) => e.isCorrect === true);
    return entries;
  }

  function getTrainingName() {
    const title = (document.title || '').split(' | ')[0];
    return norm(title) || 'weblio';
  }

  // ---------------------------------------------------------------------------
  // Ankiへの登録
  // ---------------------------------------------------------------------------

  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toTag = (s) => s.replace(/\s+/g, '_');

  function buildTags() {
    const tags = settings.tags.split(/[\s,]+/).filter(Boolean);
    if (settings.tagTrainingName) tags.push(toTag(getTrainingName()));
    return [...new Set(tags)];
  }

  async function registerToAnki(entries) {
    const { deckName, modelName, frontField, backField } = settings;

    const models = await ankiRequest('modelNames');
    if (!models.includes(modelName)) {
      throw new AnkiError(`ノートタイプ「${modelName}」がAnkiにありません。設定を確認してください。`);
    }
    const fields = await ankiRequest('modelFieldNames', { modelName });
    for (const f of [frontField, backField]) {
      if (!fields.includes(f)) {
        throw new AnkiError(`ノートタイプ「${modelName}」にフィールド「${f}」がありません（あるのは: ${fields.join(', ')}）。`);
      }
    }

    await ankiRequest('createDeck', { deck: deckName });

    // 同じ単語が1回の結果に複数あっても1枚にする
    const unique = [...new Map(entries.map((e) => [e.english, e])).values()];
    const tags = buildTags();
    const notes = unique.map((e) => ({
      deckName,
      modelName,
      fields: { [frontField]: escapeHtml(e.english), [backField]: escapeHtml(e.japanese) },
      tags,
      options: { allowDuplicate: false, duplicateScope: 'deck' },
    }));

    const addable = await ankiRequest('canAddNotes', { notes });
    const toAdd = notes.filter((_, i) => addable[i]);
    let added = 0;
    if (toAdd.length > 0) {
      const ids = await ankiRequest('addNotes', { notes: toAdd });
      added = ids.filter((id) => id !== null).length;
    }
    return { added, skipped: unique.length - added };
  }

  // ---------------------------------------------------------------------------
  // 処理済みの記録（自動登録の二重実行防止）
  // ---------------------------------------------------------------------------

  const PROCESSED_KEY = 'abw-processed';

  function isProcessed(sig) {
    try {
      return JSON.parse(sessionStorage.getItem(PROCESSED_KEY) || '[]').includes(sig);
    } catch (e) {
      return false;
    }
  }

  function markProcessed(sig) {
    try {
      const list = JSON.parse(sessionStorage.getItem(PROCESSED_KEY) || '[]');
      list.push(sig);
      sessionStorage.setItem(PROCESSED_KEY, JSON.stringify(list.slice(-50)));
    } catch (e) {
      // sessionStorageが使えない場合は記録しない
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  GM_addStyle(`
    .abw-panel, .abw-toast, .abw-modal {
      font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif;
      font-size: 13px; line-height: 1.6; color: #e8e6e3; box-sizing: border-box;
    }
    .abw-panel *, .abw-modal * { box-sizing: border-box; }
    .abw-panel {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: 280px;
      background: #23262b; border: 1px solid #3a3f46; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); overflow: hidden;
    }
    .abw-panel-head {
      display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      background: #5a3510; font-weight: bold;
    }
    .abw-panel-head span { flex: 1; }
    .abw-icon-btn {
      background: none; border: none; color: #e8e6e3; cursor: pointer;
      font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 4px;
    }
    .abw-icon-btn:hover { background: rgba(255,255,255,.12); }
    .abw-panel-body { padding: 10px 12px 12px; }
    .abw-panel-info { margin: 0 0 4px; }
    .abw-panel-status { margin: 0 0 10px; min-height: 1.6em; color: #b8b4ad; }
    .abw-panel-status.abw-ok { color: #5fd3a5; }
    .abw-panel-status.abw-err { color: #ff8a73; }
    .abw-btn {
      display: inline-block; border: none; border-radius: 999px; cursor: pointer;
      padding: 7px 16px; font-weight: bold; font-size: 13px; color: #fff; background: #c26f1c;
    }
    .abw-btn:hover { background: #d98128; }
    .abw-btn:disabled { opacity: .5; cursor: default; }
    .abw-btn.abw-sub { background: #3a3f46; }
    .abw-btn.abw-sub:hover { background: #4a5058; }
    .abw-panel .abw-btn { width: 100%; }
    .abw-toast-wrap {
      position: fixed; top: 16px; right: 16px; z-index: 2147483001;
      display: flex; flex-direction: column; gap: 8px; pointer-events: none;
    }
    .abw-toast {
      max-width: 360px; padding: 10px 14px; border-radius: 8px; background: #23262b;
      border-left: 4px solid #5fd3a5; box-shadow: 0 6px 24px rgba(0,0,0,.35);
      transition: opacity .3s;
    }
    .abw-toast.abw-err { border-left-color: #ff8a73; }
    .abw-modal-overlay {
      position: fixed; inset: 0; z-index: 2147483002; background: rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center; padding: 16px;
    }
    .abw-modal {
      width: 100%; max-width: 460px; max-height: calc(100vh - 32px); overflow: auto;
      background: #23262b; border: 1px solid #3a3f46; border-radius: 12px; padding: 18px 20px;
    }
    .abw-modal h2 { margin: 0 0 14px; font-size: 16px; color: #e8e6e3; }
    .abw-field { display: block; margin-bottom: 12px; }
    .abw-field > span { display: block; margin-bottom: 4px; font-weight: bold; }
    .abw-field input[type="text"], .abw-field select {
      width: 100%; padding: 6px 8px; border-radius: 6px; font-size: 13px;
      border: 1px solid #4a5058; background: #181a1d; color: #e8e6e3;
    }
    .abw-field-row { display: flex; gap: 10px; }
    .abw-field-row .abw-field { flex: 1; }
    .abw-check { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
    .abw-hint { margin: -6px 0 12px; font-size: 12px; color: #9a968f; }
    .abw-modal-msg { min-height: 1.6em; margin: 0 0 12px; color: #b8b4ad; }
    .abw-modal-msg.abw-ok { color: #5fd3a5; }
    .abw-modal-msg.abw-err { color: #ff8a73; }
    .abw-modal-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .abw-modal-actions .abw-spacer { flex: 1; }
  `);

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }

  // --- トースト ---

  let toastWrap = null;

  function toast(message, isError = false) {
    if (!toastWrap || !toastWrap.isConnected) {
      toastWrap = el('div', { class: 'abw-toast-wrap' });
      document.body.append(toastWrap);
    }
    const t = el('div', { class: 'abw-toast' + (isError ? ' abw-err' : ''), text: message });
    toastWrap.append(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, isError ? 8000 : 5000);
  }

  // --- フローティングパネル ---

  let panel = null;

  function setPanelStatus(text, kind = '') {
    if (!panel) return;
    panel.status.textContent = text;
    panel.status.className = 'abw-panel-status' + (kind ? ' abw-' + kind : '');
  }

  function renderPanelInfo() {
    if (!panel || !current) return;
    const targets = filterEntries(current.entries, settings.target);
    panel.info.textContent =
      `${current.entries.length}語を検出 ／ 登録対象（${TARGET_LABELS[settings.target]}）: ${targets.length}語`;
  }

  function showPanel() {
    if (!panel || !panel.root.isConnected) {
      const info = el('p', { class: 'abw-panel-info' });
      const status = el('p', { class: 'abw-panel-status' });
      const button = el('button', { class: 'abw-btn', type: 'button', text: 'Ankiに登録', onclick: () => runRegister() });
      const root = el('div', { class: 'abw-panel' }, [
        el('div', { class: 'abw-panel-head' }, [
          el('span', { text: 'AnkiBridge for Weblio' }),
          el('button', { class: 'abw-icon-btn', type: 'button', title: '設定', text: '⚙', onclick: openSettings }),
          el('button', { class: 'abw-icon-btn', type: 'button', title: '閉じる', text: '×', onclick: hidePanel }),
        ]),
        el('div', { class: 'abw-panel-body' }, [info, status, button]),
      ]);
      document.body.append(root);
      panel = { root, info, status, button };
    }
    renderPanelInfo();
    setPanelStatus(settings.mode === 'auto' ? '' : '「Ankiに登録」を押すと登録します');
  }

  function hidePanel() {
    if (panel) panel.root.remove();
    panel = null;
  }

  // --- 設定画面 ---

  function openSettings() {
    if (document.querySelector('.abw-modal-overlay')) return;

    const input = (name, value, list) =>
      el('input', { type: 'text', name, value, ...(list ? { list } : {}), autocomplete: 'off' });
    const select = (name, labels, value) => {
      const s = el('select', { name });
      for (const [v, label] of Object.entries(labels)) {
        const o = el('option', { value: v, text: label });
        if (v === value) o.selected = true;
        s.append(o);
      }
      return s;
    };
    const field = (label, control) => el('label', { class: 'abw-field' }, [el('span', { text: label }), control]);

    const deckList = el('datalist', { id: 'abw-deck-list' });
    const modelList = el('datalist', { id: 'abw-model-list' });
    const fieldList = el('datalist', { id: 'abw-field-list' });

    const f = {
      mode: select('mode', MODE_LABELS, settings.mode),
      target: select('target', TARGET_LABELS, settings.target),
      deckName: input('deckName', settings.deckName, 'abw-deck-list'),
      modelName: input('modelName', settings.modelName, 'abw-model-list'),
      frontField: input('frontField', settings.frontField, 'abw-field-list'),
      backField: input('backField', settings.backField, 'abw-field-list'),
      tags: input('tags', settings.tags),
      tagTrainingName: el('input', { type: 'checkbox', name: 'tagTrainingName' }),
      ankiUrl: input('ankiUrl', settings.ankiUrl),
    };
    f.tagTrainingName.checked = settings.tagTrainingName;

    const msg = el('p', { class: 'abw-modal-msg' });
    const setMsg = (text, kind = '') => {
      msg.textContent = text;
      msg.className = 'abw-modal-msg' + (kind ? ' abw-' + kind : '');
    };

    // 接続テストや候補取得は、画面上で入力中のURLで行う
    const withFormUrl = async (fn) => {
      const saved = settings.ankiUrl;
      settings = { ...settings, ankiUrl: f.ankiUrl.value.trim() || DEFAULTS.ankiUrl };
      try {
        return await fn();
      } finally {
        settings = { ...settings, ankiUrl: saved };
      }
    };

    const testConnection = async () => {
      setMsg('接続中…');
      try {
        const version = await withFormUrl(() => ankiRequest('version'));
        setMsg(`接続OK（AnkiConnect version ${version}）`, 'ok');
      } catch (e) {
        setMsg(e.message, 'err');
      }
    };

    const fetchCandidates = async () => {
      setMsg('Ankiから候補を取得中…');
      try {
        const [decks, models] = await withFormUrl(() => Promise.all([ankiRequest('deckNames'), ankiRequest('modelNames')]));
        const fill = (list, values) => list.replaceChildren(...values.map((v) => el('option', { value: v })));
        fill(deckList, decks);
        fill(modelList, models);
        const modelName = f.modelName.value.trim();
        if (models.includes(modelName)) {
          const fields = await withFormUrl(() => ankiRequest('modelFieldNames', { modelName }));
          fill(fieldList, fields);
          setMsg(`候補を取得しました。「${modelName}」のフィールド: ${fields.join(', ')}`, 'ok');
        } else {
          setMsg(`候補を取得しました。ノートタイプ「${modelName}」は見つかりません（あるのは: ${models.join(', ')}）`, 'err');
        }
      } catch (e) {
        setMsg(e.message, 'err');
      }
    };

    const close = () => overlay.remove();

    const save = () => {
      saveSettings({
        mode: f.mode.value,
        target: f.target.value,
        deckName: f.deckName.value.trim() || DEFAULTS.deckName,
        modelName: f.modelName.value.trim() || DEFAULTS.modelName,
        frontField: f.frontField.value.trim() || DEFAULTS.frontField,
        backField: f.backField.value.trim() || DEFAULTS.backField,
        tags: f.tags.value.trim(),
        tagTrainingName: f.tagTrainingName.checked,
        ankiUrl: f.ankiUrl.value.trim() || DEFAULTS.ankiUrl,
      });
      renderPanelInfo();
      toast('設定を保存しました');
      close();
    };

    const modal = el('div', { class: 'abw-modal', role: 'dialog', 'aria-modal': 'true' }, [
      el('h2', { text: 'AnkiBridge for Weblio 設定' }),
      field('登録モード', f.mode),
      field('登録対象', f.target),
      field('デッキ名', f.deckName),
      field('ノートタイプ', f.modelName),
      el('div', { class: 'abw-field-row' }, [field('表（英単語）のフィールド', f.frontField), field('裏（日本語訳）のフィールド', f.backField)]),
      el('p', { class: 'abw-hint', text: '英語版Ankiの場合は ノートタイプ: Basic / フィールド: Front, Back' }),
      field('タグ（スペース区切り）', f.tags),
      el('label', { class: 'abw-check' }, [f.tagTrainingName, el('span', { text: 'トレーニング名をタグに追加する' })]),
      field('AnkiConnect URL', f.ankiUrl),
      deckList,
      modelList,
      fieldList,
      msg,
      el('div', { class: 'abw-modal-actions' }, [
        el('button', { class: 'abw-btn abw-sub', type: 'button', text: '接続テスト', onclick: testConnection }),
        el('button', { class: 'abw-btn abw-sub', type: 'button', text: 'Ankiから候補を取得', onclick: fetchCandidates }),
        el('span', { class: 'abw-spacer' }),
        el('button', { class: 'abw-btn abw-sub', type: 'button', text: 'キャンセル', onclick: close }),
        el('button', { class: 'abw-btn', type: 'button', text: '保存', onclick: save }),
      ]),
    ]);

    const overlay = el('div', { class: 'abw-modal-overlay' }, modal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    document.body.append(overlay);
    f.mode.focus();
  }

  // ---------------------------------------------------------------------------
  // 登録の実行
  // ---------------------------------------------------------------------------

  let current = null; // { sig, entries }
  let busy = false;

  async function runRegister({ auto = false } = {}) {
    if (!current || busy) return;
    const { sig } = current;
    const targets = filterEntries(current.entries, settings.target);
    if (targets.length === 0) {
      setPanelStatus(`登録対象（${TARGET_LABELS[settings.target]}）の単語はありません`);
      if (auto) markProcessed(sig);
      return;
    }

    busy = true;
    if (panel) panel.button.disabled = true;
    setPanelStatus(`${targets.length}語をAnkiに登録中…`);
    try {
      const { added, skipped } = await registerToAnki(targets);
      const text = `Ankiに${added}語を登録しました` + (skipped ? `（${skipped}語は登録済みのためスキップ）` : '');
      setPanelStatus(text, 'ok');
      toast(text);
      markProcessed(sig);
    } catch (e) {
      const text = e instanceof AnkiError ? e.message : `登録に失敗しました: ${e.message}`;
      setPanelStatus(text, 'err');
      toast(text, true);
    } finally {
      busy = false;
      if (panel) panel.button.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 結果画面の監視
  // ---------------------------------------------------------------------------

  function check() {
    const found = findResultList();
    const entries = found && extractEntries(found);
    if (!entries) {
      if (current) {
        current = null;
        hidePanel();
      }
      return;
    }

    const sig = location.pathname + '|' + getTrainingName() + '|' + entries.map((e) => e.english).join(',');
    if (current && current.sig === sig) return;

    current = { sig, entries };
    showPanel();
    if (settings.mode === 'auto') {
      if (isProcessed(sig)) setPanelStatus('この結果は登録済みです（再登録はボタンから）');
      else runRegister({ auto: true });
    }
  }

  let timer = null;
  const scheduleCheck = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 300);
  };

  new MutationObserver(scheduleCheck).observe(document.body, { childList: true, subtree: true });
  scheduleCheck();

  GM_registerMenuCommand('設定を開く', openSettings);
  GM_registerMenuCommand('この結果をAnkiに登録', () => {
    check();
    if (current) runRegister();
    else toast('単語トレーニングの結果画面が見つかりません', true);
  });
})();
