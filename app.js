/* ===========================
   ガード成績表管理 — app.js
   データ共有対応版（Firestore リアルタイム同期）
=========================== */

// ===================== STATE =====================
let state = {
  sheets: [],          // Firestore から取得したシート一覧
  currentSheetId: null, // localStorage で端末ごとに保持
  adminPassHash: null,  // localStorage で端末ごとに保持
  draftLayout: [],      // シートごとに Firestore に保存
  draftBgImage: null,   // シートごとに Firestore に保存
};

let selectedElementId = null;
let currentPdfCandidateIdx = 0;
let editingLinkElementId = null;
let pendingUnlockSheetId = null;
let pendingDeleteSheetId = null;

// Firestore のリアルタイムリスナー解除用
let _unsubscribeSheets = null;
let _unsubscribeCurrentSheet = null;

// Default settings
const DEFAULT_SETTINGS = () => ({
  examiners: ['きたの', 'さかの', 'たきの', 'ゆきの'],
  items: ['項目①', '項目②', '項目③', '項目④', '項目⑤'],
  comments: ['コメント①', 'コメント②', 'コメント③'],
  gradeScale: [
    { label: 'SS',  value: 5 },
    { label: 'S+',  value: 4.5 },
    { label: 'S',   value: 4 },
    { label: 'S-',  value: 3.9 },
    { label: 'A+',  value: 3.5 },
    { label: 'A',   value: 3 },
    { label: 'A-',  value: 2.9 },
    { label: 'B+',  value: 2.5 },
    { label: 'B',   value: 2 },
    { label: 'B-',  value: 1.9 },
    { label: 'C+',  value: 1.5 },
    { label: 'C',   value: 1 },
  ],
});

// ===================== FIRESTORE ヘルパー =====================
function _db()              { return window.__db; }
function _doc(...args)      { return window.__fsDoc(...args); }
function _getDoc(ref)       { return window.__fsGetDoc(ref); }
function _setDoc(ref, d)    { return window.__fsSetDoc(ref, d); }
function _delDoc(ref)       { return window.__fsDeleteDoc(ref); }
function _col(...args)      { return window.__fsCollection(...args); }
function _getDocs(ref)      { return window.__fsGetDocs(ref); }
function _onSnapshot(ref, cb, err) { return window.__fsOnSnapshot(ref, cb, err); }

// ===================== LOCAL STORAGE（端末固有データ）=====================
const LS_ADMIN  = 'guard_adminPassHash';
const LS_SHEET  = 'guard_currentSheetId';

function lsGet(key)        { try { return localStorage.getItem(key); } catch(e) { return null; } }
function lsSet(key, val)   { try { localStorage.setItem(key, val); } catch(e) {} }
function lsDel(key)        { try { localStorage.removeItem(key); } catch(e) {} }

function loadLocalState() {
  state.adminPassHash  = lsGet(LS_ADMIN)  || null;
  state.currentSheetId = lsGet(LS_SHEET) || null;
  console.log('[LocalStorage] adminPassHash:', state.adminPassHash ? '設定済み' : 'なし');
  console.log('[LocalStorage] currentSheetId:', state.currentSheetId);
}

function saveLocalState() {
  if (state.adminPassHash) lsSet(LS_ADMIN, state.adminPassHash);
  else lsDel(LS_ADMIN);
  if (state.currentSheetId) lsSet(LS_SHEET, state.currentSheetId);
  else lsDel(LS_SHEET);
}

// ===================== FIRESTORE 保存 =====================

// シート1件をFirestoreに保存（draftLayout / draftBgImageも含む）
function saveSheet(sheet) {
  if (!_db()) { console.warn('[Firestore] db未初期化'); return; }
  const data = JSON.parse(JSON.stringify(sheet));
  _setDoc(_doc(_db(), 'sheets', sheet.id), data)
    .then(() => console.log('[Firestore] シート保存完了:', sheet.id, sheet.name))
    .catch(e => console.error('[Firestore] saveSheet エラー:', e));
}

// シートの成績・設定・レイアウトをまとめて保存
function saveState() {
  const sheet = currentSheet();
  if (sheet) saveSheet(sheet);
}

// ===================== FIRESTORE 読み込み（初回）=====================
async function loadState() {
  if (!_db()) { console.warn('[Firestore] db未初期化'); return; }

  console.log('[Firestore] データ読み込み開始...');
  try {
    const snaps = await _getDocs(_col(_db(), 'sheets'));
    state.sheets = [];
    snaps.forEach(s => state.sheets.push(s.data()));
    state.sheets.sort((a, b) => (b.createdAt || '') > (a.createdAt || '') ? 1 : -1);
    console.log('[Firestore] シート一覧取得:', state.sheets.length, '件');
    state.sheets.forEach(s => console.log('  -', s.id, s.name));
  } catch(e) {
    console.error('[Firestore] loadState エラー:', e);
  }
}

// ===================== リアルタイム同期（onSnapshot）=====================

// シート一覧のリアルタイム監視を開始
function startSheetsListener() {
  if (!_db()) return;
  if (_unsubscribeSheets) _unsubscribeSheets(); // 既存リスナーを解除

  console.log('[Firestore] シート一覧リスナー開始');
  _unsubscribeSheets = _onSnapshot(
    _col(_db(), 'sheets'),
    (snapshot) => {
      console.log('[Firestore] シート一覧更新:', snapshot.docs.length, '件');
      state.sheets = [];
      snapshot.forEach(s => state.sheets.push(s.data()));
      state.sheets.sort((a, b) => (b.createdAt || '') > (a.createdAt || '') ? 1 : -1);

      // 現在のシートも更新
      const cur = currentSheet();
      if (cur) {
        state.draftLayout  = cur.draftLayout  || [];
        state.draftBgImage = cur.draftBgImage || null;
      }

      // 現在表示中の画面を再描画
      const activeScreen = document.querySelector('.screen.active')?.id;
      if (activeScreen === 'screen-menu') {
        renderMenu();
      } else if (activeScreen === 'screen-grade') {
        buildGradeTable();
      } else if (activeScreen === 'screen-pdf') {
        renderPdfScreen();
      }
    },
    (err) => console.error('[Firestore] シート一覧リスナーエラー:', err)
  );
}

// ===================== HELPERS =====================
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function currentSheet() { return state.sheets.find(s => s.id === state.currentSheetId) || null; }

async function hashPassword(plain) {
  const salt = 'guard-grade-app::';
  const data = new TextEncoder().encode(salt + plain);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function gradeValue(label, gradeScale) {
  const g = gradeScale.find(g => g.label === label);
  return g ? g.value : null;
}
function valueToLabel(value, gradeScale) {
  if (value === null || value === undefined) return '-';
  if (!gradeScale.length) return '-';
  let closest = gradeScale[0];
  let minDiff = Math.abs(value - gradeScale[0].value);
  for (const g of gradeScale) {
    const diff = Math.abs(value - g.value);
    if (diff < minDiff) { minDiff = diff; closest = g; }
  }
  return closest.label;
}

// ===================== SCREEN NAV =====================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

function goToMenu() { showScreen('menu'); renderMenu(); }

function goToGrade() {
  showScreen('grade');
  renderGradeScreen();
}

function goToPdf() {
  showScreen('pdf');
  renderPdfScreen();
}

// ===================== SCREEN 1 — MENU =====================
function renderMenu() {
  const list = document.getElementById('sheet-list');
  if (!state.sheets.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">&#128196;</div><p>シートがありません。上から新規作成してください。</p></div>`;
    return;
  }
  list.innerHTML = state.sheets.map(sheet => `
    <div class="sheet-card" onclick="openSheet('${sheet.id}')">
      <div>
        <div class="sheet-card-name">&#128274; ${esc(sheet.name)}</div>
        <div class="sheet-card-meta">作成日：${sheet.createdAt} &nbsp;|&nbsp; 受験者：${sheet.candidates.length}名 &nbsp;|&nbsp; パスワード保護</div>
      </div>
      <div class="sheet-card-actions" onclick="event.stopPropagation()">
        <button class="btn-icon edit" title="開く" onclick="openSheet('${sheet.id}')">&#128196;</button>
        <button class="btn-icon del" title="削除（管理者PW必要）" onclick="deleteSheet('${sheet.id}')">&#128465;</button>
      </div>
    </div>
  `).join('');
}

async function createSheet() {
  const nameEl = document.getElementById('new-sheet-name');
  const passEl = document.getElementById('new-sheet-pass');
  const createBtn = document.querySelector('.new-sheet-card-inner .btn-primary');
  const name = nameEl.value.trim();
  const pass = passEl.value;
  if (!name) { nameEl.focus(); return; }
  if (!pass) { alert('パスワードを設定してください。'); passEl.focus(); return; }

  if (createBtn) { createBtn.disabled = true; createBtn.textContent = '作成中...'; }

  const sheet = {
    id: uid(), name,
    createdAt: new Date().toLocaleDateString('ja-JP'),
    passHash: await hashPassword(pass),
    settings: DEFAULT_SETTINGS(),
    candidates: [],
    draftLayout: [],
    draftBgImage: null,
    examDate: '',
  };

  console.log('[createSheet] Firestoreに保存中...', sheet.id, sheet.name);
  if (!_db()) {
    alert('Firebase が初期化されていません。ページを再読み込みしてください。');
    if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'シートを作成'; }
    return;
  }

  try {
    await _setDoc(_doc(_db(), 'sheets', sheet.id), JSON.parse(JSON.stringify(sheet)));
    console.log('[createSheet] 保存成功:', sheet.id);
    nameEl.value = '';
    passEl.value = '';
    // onSnapshot が自動的に renderMenu() を呼ぶ
  } catch(e) {
    console.error('[createSheet] 保存失敗:', e);
    alert('シートの作成に失敗しました。\nエラー: ' + e.message + '\n\nFirestoreのセキュリティルールを確認してください。');
  } finally {
    if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'シートを作成'; }
  }
}

function openSheet(id) {
  const sheet = state.sheets.find(s => s.id === id);
  if (!sheet) return;
  if (!sheet.passHash) {
    state.currentSheetId = id;
    saveLocalState();
    _syncDraftFromSheet();
    goToGrade();
    return;
  }
  pendingUnlockSheetId = id;
  document.getElementById('unlock-target-name').textContent = sheet.name;
  document.getElementById('unlock-pass').value = '';
  document.getElementById('unlock-error').style.display = 'none';
  openModal('modal-unlock');
  setTimeout(() => document.getElementById('unlock-pass').focus(), 50);
}

async function submitUnlock() {
  const sheet = state.sheets.find(s => s.id === pendingUnlockSheetId);
  if (!sheet) return closeModal('modal-unlock');
  const pass = document.getElementById('unlock-pass').value;
  const h = await hashPassword(pass);
  if (h === sheet.passHash) {
    state.currentSheetId = sheet.id;
    saveLocalState();
    _syncDraftFromSheet();
    closeModal('modal-unlock');
    goToGrade();
    console.log('[Auth] シートを開きました:', sheet.name);
  } else {
    document.getElementById('unlock-error').style.display = '';
    document.getElementById('unlock-pass').value = '';
    document.getElementById('unlock-pass').focus();
    console.warn('[Auth] パスワード不一致');
  }
}

// シートのdraftLayout/draftBgImageをstateに同期
function _syncDraftFromSheet() {
  const sheet = currentSheet();
  if (!sheet) return;
  state.draftLayout  = sheet.draftLayout  || [];
  state.draftBgImage = sheet.draftBgImage || null;
}

function deleteSheet(id) {
  const sheet = state.sheets.find(s => s.id === id);
  if (!sheet) return;
  if (!state.adminPassHash) {
    openAdminSetup();
    return;
  }
  pendingDeleteSheetId = id;
  document.getElementById('delete-target-name').textContent = '「' + sheet.name + '」を削除します。';
  document.getElementById('delete-pass').value = '';
  document.getElementById('delete-error').style.display = 'none';
  openModal('modal-delete');
  setTimeout(() => document.getElementById('delete-pass').focus(), 50);
}

async function submitDelete() {
  const pass = document.getElementById('delete-pass').value;
  const h = await hashPassword(pass);
  if (h === state.adminPassHash) {
    const deletedId = pendingDeleteSheetId;
    pendingDeleteSheetId = null;
    if (_db()) _delDoc(_doc(_db(), 'sheets', deletedId))
      .then(() => console.log('[Firestore] シート削除完了:', deletedId))
      .catch(e => console.error('[Firestore] deleteSheet エラー:', e));
    if (state.currentSheetId === deletedId) {
      state.currentSheetId = null;
      saveLocalState();
    }
    closeModal('modal-delete');
    // onSnapshot が自動的に renderMenu() を呼ぶ
  } else {
    document.getElementById('delete-error').style.display = '';
    document.getElementById('delete-pass').value = '';
    document.getElementById('delete-pass').focus();
  }
}

function openAdminSetup() {
  document.getElementById('admin-setup-pass').value = '';
  document.getElementById('admin-setup-pass2').value = '';
  document.getElementById('admin-setup-error').style.display = 'none';
  openModal('modal-admin-setup');
  setTimeout(() => document.getElementById('admin-setup-pass').focus(), 50);
}

async function submitAdminSetup() {
  const p1 = document.getElementById('admin-setup-pass').value;
  const p2 = document.getElementById('admin-setup-pass2').value;
  const errEl = document.getElementById('admin-setup-error');
  if (!p1) { errEl.textContent = 'パスワードを入力してください。'; errEl.style.display = ''; return; }
  if (p1 !== p2) { errEl.textContent = 'パスワードが一致しません。'; errEl.style.display = ''; return; }
  state.adminPassHash = await hashPassword(p1);
  saveLocalState();
  closeModal('modal-admin-setup');
  alert('管理者パスワードを設定しました。もう一度削除ボタンを押すと、このパスワードで削除できます。');
}

// ===================== SCREEN 2 — GRADE TABLE =====================
function renderGradeScreen() {
  const sheet = currentSheet();
  if (!sheet) return goToMenu();
  document.getElementById('grade-sheet-title').textContent = sheet.name;
  renderSettingsSummary();
  buildGradeTable();
}

function renderSettingsSummary() {
  const sheet = currentSheet();
  const s = sheet.settings;
  document.getElementById('settings-summary').textContent =
    `試験官：${s.examiners.join('、')} ／ 項目：${s.items.join('、')}`;
}

function buildGradeTable() {
  const sheet = currentSheet();
  if (!sheet) return;
  const { settings, candidates } = sheet;
  const thead = document.getElementById('grade-thead');
  const tbody = document.getElementById('grade-tbody');

  let hrow = `<tr>
    <th rowspan="2" style="vertical-align:middle">受験者</th>
    <th rowspan="2" style="vertical-align:middle">試験官</th>
    ${settings.items.map(it => `<th>${esc(it)}</th>`).join('')}
    <th rowspan="2" class="col-avg" style="vertical-align:middle">平均評価</th>
    ${settings.comments.map(c => `<th class="col-comment">${esc(c)}</th>`).join('')}
    <th rowspan="2" class="col-action" style="vertical-align:middle">操作</th>
  </tr>`;
  thead.innerHTML = hrow;

  if (!candidates.length) {
    tbody.innerHTML = `<tr><td colspan="${2 + settings.items.length + 1 + settings.comments.length + 1}" style="text-align:center;padding:32px;color:#9ca3af">受験者を追加ボタン、または一括入力ボタンから追加してください</td></tr>`;
    return;
  }

  let html = '';
  candidates.forEach((cand, ci) => {
    if (!cand.examiners) cand.examiners = {};
    settings.examiners.forEach(ex => {
      if (!cand.examiners[ex]) cand.examiners[ex] = { grades: {} };
      settings.items.forEach(it => {
        if (!cand.examiners[ex].grades[it]) cand.examiners[ex].grades[it] = '';
      });
    });
    if (!cand.comments) cand.comments = {};
    settings.comments.forEach(c => { if (!cand.comments[c]) cand.comments[c] = ''; });

    const rowspan = settings.examiners.length + 1;

    settings.examiners.forEach((ex, ei) => {
      html += `<tr>`;
      if (ei === 0) {
        html += `<td class="col-name" rowspan="${rowspan}">${esc(cand.name)}</td>`;
      }
      html += `<td style="white-space:nowrap;font-weight:600;font-size:13px">${esc(ex)}</td>`;
      settings.items.forEach(it => {
        const val = cand.examiners[ex].grades[it] || '';
        html += `<td>${buildGradeSelect(ci, ex, it, val, settings.gradeScale)}</td>`;
      });
      if (ei === 0) {
        const avg = calcAvg(cand, settings);
        const avgLabel = avg !== null ? valueToLabel(avg, settings.gradeScale) : '-';
        const avgNum = avg !== null ? avg.toFixed(2) : '-';
        html += `<td class="col-avg" rowspan="${rowspan}"><span class="avg-badge">${esc(avgLabel)}<br><small style="font-weight:400;font-size:10px">${avgNum}</small></span></td>`;
        settings.comments.forEach(c => {
          html += `<td class="col-comment" rowspan="${rowspan}">
            <textarea class="comment-input" rows="3"
              onchange="setComment(${ci},'${escStr(c)}',this.value)"
              placeholder="${esc(c)}を入力">${esc(cand.comments[c])}</textarea>
          </td>`;
        });
        html += `<td class="col-action" rowspan="${rowspan}">
          <button class="btn-icon del" title="この受験者を削除" onclick="deleteCandidate(${ci})">&#128465;</button>
        </td>`;
      }
      html += `</tr>`;
    });

    html += `<tr class="avg-row">
      <td style="font-weight:700;font-size:12px;color:#065f46">平均評価</td>
      ${settings.items.map(it => {
        const itemAvg = calcItemAvg(cand, it, settings);
        const lbl = itemAvg !== null ? valueToLabel(itemAvg, settings.gradeScale) : '-';
        return `<td style="font-weight:700;color:#065f46">${lbl}<br><small style="font-weight:400;font-size:10px;color:#9ca3af">${itemAvg !== null ? itemAvg.toFixed(2) : '-'}</small></td>`;
      }).join('')}
    </tr>`;

    html += `<tr class="sep-row"><td colspan="${2 + settings.items.length + 1 + settings.comments.length + 1}"></td></tr>`;
  });

  tbody.innerHTML = html;
}

function buildGradeSelect(ci, ex, it, val, gradeScale) {
  const opts = ['', ...gradeScale.map(g => g.label)]
    .map(g => `<option value="${esc(g)}" ${g === val ? 'selected' : ''}>${g || '-'}</option>`)
    .join('');
  return `<select class="grade-select" onchange="setGrade(${ci},'${escStr(ex)}','${escStr(it)}',this.value)">${opts}</select>`;
}

function setGrade(ci, ex, it, val) {
  const sheet = currentSheet();
  if (!sheet) return;
  sheet.candidates[ci].examiners[ex].grades[it] = val;
  console.log('[成績更新]', sheet.candidates[ci].name, ex, it, '->', val);
  saveState();
  buildGradeTable();
}

function setComment(ci, col, val) {
  const sheet = currentSheet();
  if (!sheet) return;
  sheet.candidates[ci].comments[col] = val;
  saveState();
}

function calcAvg(cand, settings) {
  let total = 0, count = 0;
  settings.examiners.forEach(ex => {
    settings.items.forEach(it => {
      const label = cand.examiners?.[ex]?.grades?.[it];
      const v = gradeValue(label, settings.gradeScale);
      if (v !== null && v !== undefined) { total += v; count++; }
    });
  });
  return count ? total / count : null;
}

function calcItemAvg(cand, item, settings) {
  let total = 0, count = 0;
  settings.examiners.forEach(ex => {
    const label = cand.examiners?.[ex]?.grades?.[item];
    const v = gradeValue(label, settings.gradeScale);
    if (v !== null && v !== undefined) { total += v; count++; }
  });
  return count ? total / count : null;
}

function openImportModal() { openModal('modal-import'); }

function openAddCandidate() {
  document.getElementById('add-candidate-name').value = '';
  openModal('modal-add-candidate');
  setTimeout(() => document.getElementById('add-candidate-name').focus(), 50);
}

function addCandidate() {
  const sheet = currentSheet();
  if (!sheet) return;
  const input = document.getElementById('add-candidate-name');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  if (sheet.candidates.find(c => c.name === name)) {
    alert('同じ名前の受験者が既にいます。');
    return;
  }
  sheet.candidates.push({ id: uid(), name, examiners: {}, comments: {} });
  input.value = '';
  saveState();
  closeModal('modal-add-candidate');
  buildGradeTable();
}

function deleteCandidate(ci) {
  const sheet = currentSheet();
  if (!sheet) return;
  const cand = sheet.candidates[ci];
  if (!cand) return;
  if (!confirm('「' + cand.name + '」を削除しますか？\nこの受験者の成績・コメントもすべて削除されます。')) return;
  sheet.candidates.splice(ci, 1);
  if (currentPdfCandidateIdx >= sheet.candidates.length) {
    currentPdfCandidateIdx = Math.max(0, sheet.candidates.length - 1);
  }
  saveState();
  buildGradeTable();
}

function importCandidates() {
  const sheet = currentSheet();
  if (!sheet) return;
  const text = document.getElementById('import-textarea').value;
  const names = text.split('\n').map(s => s.trim()).filter(Boolean);
  names.forEach(name => {
    if (!sheet.candidates.find(c => c.name === name)) {
      sheet.candidates.push({ id: uid(), name, examiners: {}, comments: {} });
    }
  });
  document.getElementById('import-textarea').value = '';
  saveState();
  closeModal('modal-import');
  buildGradeTable();
}

// ===================== SETTINGS MODAL =====================
let tempSettings = null;
let origSettings = null;

function openSettings() {
  const sheet = currentSheet();
  if (!sheet) return;
  tempSettings = JSON.parse(JSON.stringify(sheet.settings));
  origSettings = {
    examiners: [...sheet.settings.examiners],
    items: [...sheet.settings.items],
    comments: [...sheet.settings.comments],
  };
  renderSettingsModal();
  openModal('modal-settings');
}

function renderSettingsModal() {
  renderEditList('examiner-list', tempSettings.examiners, 'examiner');
  renderEditList('item-list', tempSettings.items, 'item');
  renderEditList('comment-list', tempSettings.comments, 'comment');
  renderGradeScaleList();
}

function renderEditList(containerId, arr, kind) {
  const el = document.getElementById(containerId);
  el.innerHTML = arr.map((v, i) => `
    <div class="edit-item">
      <input type="text" class="edit-item-input" value="${esc(v)}"
        onchange="renameSetting('${kind}',${i},this.value)" />
      <span class="remove-tag" title="削除" onclick="removeSetting('${kind}',${i})">&#10005;</span>
    </div>
  `).join('');
}

function settingArrayByKind(kind) {
  if (kind === 'examiner') return tempSettings.examiners;
  if (kind === 'item') return tempSettings.items;
  if (kind === 'comment') return tempSettings.comments;
  return null;
}

function renameSetting(kind, i, value) {
  const arr = settingArrayByKind(kind);
  if (!arr) return;
  const v = value.trim();
  if (!v) { renderSettingsModal(); return; }
  arr[i] = v;
}

function removeSetting(kind, i) {
  const arr = settingArrayByKind(kind);
  if (!arr) return;
  arr.splice(i, 1);
  renderSettingsModal();
}

function addExaminer() {
  const v = document.getElementById('new-examiner').value.trim();
  if (!v) return;
  tempSettings.examiners.push(v);
  document.getElementById('new-examiner').value = '';
  renderSettingsModal();
}
function addItem() {
  const v = document.getElementById('new-item').value.trim();
  if (!v) return;
  tempSettings.items.push(v);
  document.getElementById('new-item').value = '';
  renderSettingsModal();
}
function addComment() {
  const v = document.getElementById('new-comment').value.trim();
  if (!v) return;
  tempSettings.comments.push(v);
  document.getElementById('new-comment').value = '';
  renderSettingsModal();
}

function renderGradeScaleList() {
  const el = document.getElementById('grade-scale-list');
  el.innerHTML = tempSettings.gradeScale.map((g, i) => `
    <div class="grade-scale-item">
      <input type="text" class="gs-label-input" value="${esc(g.label)}"
        onchange="renameGradeScaleLabel(${i},this.value)" />
      <span class="gs-eq">=</span>
      <input type="number" class="gs-value-input" value="${g.value}" step="0.1"
        onchange="setGradeScaleValue(${i},this.value)" />
      <span class="remove-tag" title="削除" onclick="removeGradeScale(${i})">&#10005;</span>
    </div>
  `).join('');
}

function renameGradeScaleLabel(i, value) {
  const v = value.trim();
  if (!v) { renderGradeScaleList(); return; }
  tempSettings.gradeScale[i].label = v;
}
function setGradeScaleValue(i, value) {
  const num = parseFloat(value);
  if (isNaN(num)) { renderGradeScaleList(); return; }
  tempSettings.gradeScale[i].value = num;
}
function removeGradeScale(i) { tempSettings.gradeScale.splice(i, 1); renderGradeScaleList(); }
function addGradeScale() {
  const label = document.getElementById('new-grade-label').value.trim();
  const value = parseFloat(document.getElementById('new-grade-value').value);
  if (!label || isNaN(value)) return;
  tempSettings.gradeScale.push({ label, value });
  tempSettings.gradeScale.sort((a, b) => b.value - a.value);
  document.getElementById('new-grade-label').value = '';
  document.getElementById('new-grade-value').value = '';
  renderGradeScaleList();
}

function saveSettings() {
  const sheet = currentSheet();
  if (!sheet) return;

  if (origSettings) {
    remapCandidateKeys(sheet, 'examiner', origSettings.examiners, tempSettings.examiners);
    remapCandidateKeys(sheet, 'item', origSettings.items, tempSettings.items);
    remapCandidateKeys(sheet, 'comment', origSettings.comments, tempSettings.comments);
    if (origSettings.comments.length === tempSettings.comments.length) {
      origSettings.comments.forEach((oldName, i) => {
        const newName = tempSettings.comments[i];
        if (oldName !== newName) {
          state.draftLayout.forEach(el => {
            if (el.type === 'text' && el.linkCol === oldName) el.linkCol = newName;
          });
        }
      });
    }
  }

  sheet.settings = tempSettings;
  // draftLayout の変更もシートに反映してから保存
  sheet.draftLayout = state.draftLayout;
  origSettings = null;
  saveState();
  closeModal('modal-settings');
  renderGradeScreen();
}

function remapCandidateKeys(sheet, kind, oldArr, newArr) {
  if (oldArr.length !== newArr.length) return;
  oldArr.forEach((oldName, i) => {
    const newName = newArr[i];
    if (oldName === newName) return;
    sheet.candidates.forEach(cand => {
      if (kind === 'examiner') {
        if (cand.examiners && cand.examiners[oldName] !== undefined) {
          cand.examiners[newName] = cand.examiners[oldName];
          delete cand.examiners[oldName];
        }
      } else if (kind === 'item') {
        if (cand.examiners) {
          Object.keys(cand.examiners).forEach(ex => {
            const grades = cand.examiners[ex]?.grades;
            if (grades && grades[oldName] !== undefined) {
              grades[newName] = grades[oldName];
              delete grades[oldName];
            }
          });
        }
      } else if (kind === 'comment') {
        if (cand.comments && cand.comments[oldName] !== undefined) {
          cand.comments[newName] = cand.comments[oldName];
          delete cand.comments[oldName];
        }
      }
    });
  });
}

// ===================== SCREEN 3 — PDF EDITOR =====================
function renderPdfScreen() {
  const sheet = currentSheet();
  if (!sheet) return;
  document.getElementById('pdf-sheet-title').textContent = sheet.name;

  // シートのdraftLayout/draftBgImageをstateに同期
  state.draftLayout  = sheet.draftLayout  || [];
  state.draftBgImage = sheet.draftBgImage || null;

  const listEl = document.getElementById('pdf-candidate-list');
  if (!sheet.candidates.length) {
    listEl.innerHTML = '<div class="hint">受験者なし</div>';
  } else {
    listEl.innerHTML = sheet.candidates.map((c, i) =>
      `<div class="candidate-item ${i === currentPdfCandidateIdx ? 'active' : ''}" onclick="selectPdfCandidate(${i})">${esc(c.name)}</div>`
    ).join('');
  }

  const bgImg  = document.getElementById('draft-bg-img');
  const prevBg = document.getElementById('preview-bg-img');
  if (state.draftBgImage) {
    bgImg.src  = state.draftBgImage; bgImg.style.display  = '';
    prevBg.src = state.draftBgImage; prevBg.style.display = '';
  } else {
    bgImg.style.display  = 'none';
    prevBg.style.display = 'none';
  }

  renderDraftElements();
  renderPreview();
}

function selectPdfCandidate(i) {
  currentPdfCandidateIdx = i;
  document.querySelectorAll('.candidate-item').forEach((el, idx) =>
    el.classList.toggle('active', idx === i));
  const sheet = currentSheet();
  document.getElementById('preview-candidate-name').textContent = sheet?.candidates[i]?.name || '';
  renderPreview();
}

// --- Draft element management ---
function renderDraftElements() {
  const container = document.getElementById('draft-elements');
  container.innerHTML = '';
  state.draftLayout.forEach(el => {
    const div = createDraftEl(el);
    container.appendChild(div);
  });
}

function createDraftEl(el) {
  const div = document.createElement('div');
  div.className = 'draft-element' + (el.id === selectedElementId ? ' selected' : '');
  div.id = 'draftEl-' + el.id;
  div.style.cssText = `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;

  let typeLabel, bodyHtml;
  if (el.type === 'chart') {
    typeLabel = 'チャート';
    bodyHtml  = `<div class="chart-placeholder"><span>&#128202;</span><span>レーダーチャート</span></div>`;
  } else if (el.type === 'name') {
    typeLabel = '受験者名';
    bodyHtml  = `<div class="auto-field-note">&#128100; 受験者の名前が自動で入ります</div>`;
  } else if (el.type === 'date') {
    typeLabel = '受験日';
    bodyHtml  = `<div class="auto-field-note">&#128197; 受験日が自動で入ります</div>`;
  } else {
    typeLabel = 'テキスト';
    const linked = el.linkCol
      ? `<span class="link-badge linked">&#128279; ${esc(el.linkCol)}</span>`
      : `<span class="link-badge">&#128279; 未紐づけ</span>`;
    bodyHtml = `
      <div class="text-el-body">
        ${linked}
        <button class="link-action-btn" onclick="openElementEdit('${el.id}')">&#128279; 紐づけボタン</button>
      </div>`;
  }

  div.innerHTML = `
    <div class="draft-element-header" data-elid="${el.id}">
      <span class="el-type">${typeLabel}</span>
      <span class="el-label">${esc(el.label || '')}</span>
      <span style="cursor:pointer;opacity:.7;font-size:11px" onclick="openElementEdit('${el.id}')">&#9998;</span>
    </div>
    <div class="draft-element-body">
      ${bodyHtml}
    </div>
    <div class="resize-handle" data-elid="${el.id}"></div>
  `;

  const header = div.querySelector('.draft-element-header');
  header.addEventListener('mousedown', e => startDrag(e, el.id, div));
  const handle = div.querySelector('.resize-handle');
  handle.addEventListener('mousedown', e => startResize(e, el.id, div));

  return div;
}

// draftLayout の変更をシートに書き込んでから Firestore に保存
function saveDraft() {
  const sheet = currentSheet();
  if (!sheet) return;
  sheet.draftLayout  = JSON.parse(JSON.stringify(state.draftLayout));
  sheet.draftBgImage = state.draftBgImage || null;
  saveSheet(sheet);
}

function addTextBox() {
  const el = { id: uid(), type: 'text', x: 40, y: 40, w: 220, h: 80, label: 'テキストボックス', linkCol: '', fontSize: 12 };
  state.draftLayout.push(el);
  saveDraft();
  renderDraftElements();
  renderPreview();
}

function addNameBox() {
  const el = { id: uid(), type: 'name', x: 40, y: 40, w: 240, h: 56, label: '受験者名', fontSize: 22 };
  state.draftLayout.push(el);
  saveDraft();
  renderDraftElements();
  renderPreview();
}

function addDateBox() {
  const el = { id: uid(), type: 'date', x: 40, y: 110, w: 200, h: 48, label: '受験日', fontSize: 16 };
  state.draftLayout.push(el);
  saveDraft();
  renderDraftElements();
  renderPreview();
}

function addChartBox() {
  const el = { id: uid(), type: 'chart', x: 200, y: 200, w: 260, h: 220, label: 'レーダーチャート' };
  state.draftLayout.push(el);
  saveDraft();
  renderDraftElements();
  renderPreview();
}

function uploadDraftImage() { document.getElementById('draft-img-upload').click(); }
function onDraftImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    state.draftBgImage = e.target.result;
    saveDraft();
    const bgImg  = document.getElementById('draft-bg-img');
    const prevBg = document.getElementById('preview-bg-img');
    bgImg.src  = state.draftBgImage; bgImg.style.display  = '';
    prevBg.src = state.draftBgImage; prevBg.style.display = '';
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function clearDraft() {
  if (!confirm('下書きのすべての要素を削除しますか？')) return;
  state.draftLayout  = [];
  state.draftBgImage = null;
  saveDraft();
  renderDraftElements();
  document.getElementById('draft-bg-img').style.display  = 'none';
  document.getElementById('preview-bg-img').style.display = 'none';
  renderPreview();
}

// --- Element edit modals ---
function openElementEdit(elId) {
  editingLinkElementId = elId;
  const el = state.draftLayout.find(e => e.id === elId);
  if (!el) return;
  if (el.type === 'text') {
    const sheet = currentSheet();
    const comments = sheet?.settings?.comments || [];
    const sel = document.getElementById('tb-link-col');
    sel.innerHTML = `<option value="">（未紐づけ）</option>` +
      comments.map(c => `<option value="${esc(c)}" ${c === el.linkCol ? 'selected' : ''}>${esc(c)}</option>`).join('');
    document.getElementById('tb-label').value    = el.label    || '';
    document.getElementById('tb-fontsize').value = el.fontSize || 12;
    openModal('modal-link');
  } else if (el.type === 'chart') {
    document.getElementById('chart-label').value = el.label || '';
    openModal('modal-chart-link');
  } else {
    const titleEl = document.getElementById('field-modal-title');
    titleEl.textContent = el.type === 'name' ? '受験者名フィールド設定' : '受験日フィールド設定';
    document.getElementById('field-fontsize').value = el.fontSize || 16;
    const dateRow = document.getElementById('field-date-row');
    if (el.type === 'date') {
      const sheet = currentSheet();
      document.getElementById('field-exam-date').value = sheet?.examDate || '';
      dateRow.style.display = '';
    } else {
      dateRow.style.display = 'none';
    }
    openModal('modal-field');
  }
}

function saveFieldEdit() {
  const el = state.draftLayout.find(e => e.id === editingLinkElementId);
  if (!el) return;
  el.fontSize = parseInt(document.getElementById('field-fontsize').value) || 16;
  if (el.type === 'date') {
    const sheet = currentSheet();
    if (sheet) sheet.examDate = document.getElementById('field-exam-date').value;
  }
  saveDraft();
  closeModal('modal-field');
  renderDraftElements();
  renderPreview();
}

function saveTextBoxLink() {
  const el = state.draftLayout.find(e => e.id === editingLinkElementId);
  if (!el) return;
  el.label    = document.getElementById('tb-label').value;
  el.linkCol  = document.getElementById('tb-link-col').value;
  el.fontSize = parseInt(document.getElementById('tb-fontsize').value) || 12;
  saveDraft();
  closeModal('modal-link');
  renderDraftElements();
  renderPreview();
}

function saveChartLink() {
  const el = state.draftLayout.find(e => e.id === editingLinkElementId);
  if (!el) return;
  el.label = document.getElementById('chart-label').value;
  saveDraft();
  closeModal('modal-chart-link');
  renderDraftElements();
  renderPreview();
}

function deleteElement() {
  state.draftLayout = state.draftLayout.filter(e => e.id !== editingLinkElementId);
  saveDraft();
  closeModal('modal-link');
  closeModal('modal-chart-link');
  closeModal('modal-field');
  renderDraftElements();
  renderPreview();
}

// --- Drag ---
function startDrag(e, elId, div) {
  if (e.target.closest('.resize-handle') || e.target.tagName === 'SPAN' && e.target.style.cursor === 'pointer') return;
  e.preventDefault();
  selectedElementId = elId;
  document.querySelectorAll('.draft-element').forEach(d => d.classList.remove('selected'));
  div.classList.add('selected');

  const el     = state.draftLayout.find(e2 => e2.id === elId);
  const canvas = document.getElementById('a4-canvas').getBoundingClientRect();
  const startX = e.clientX - canvas.left - el.x;
  const startY = e.clientY - canvas.top  - el.y;

  function onMove(ev) {
    const x = Math.max(0, Math.min(794 - el.w, ev.clientX - canvas.left - startX));
    const y = Math.max(0, Math.min(1123 - el.h, ev.clientY - canvas.top  - startY));
    el.x = Math.round(x); el.y = Math.round(y);
    div.style.left = el.x + 'px'; div.style.top = el.y + 'px';
  }
  function onUp() {
    saveDraft();
    renderPreview();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// --- Resize ---
function startResize(e, elId, div) {
  e.preventDefault(); e.stopPropagation();
  const el     = state.draftLayout.find(e2 => e2.id === elId);
  const startX = e.clientX; const startY = e.clientY;
  const startW = el.w;      const startH = el.h;

  function onMove(ev) {
    el.w = Math.max(80,  Math.min(794  - el.x, startW + ev.clientX - startX));
    el.h = Math.max(40,  Math.min(1123 - el.y, startH + ev.clientY - startY));
    div.style.width  = el.w + 'px';
    div.style.height = el.h + 'px';
  }
  function onUp() {
    saveDraft();
    renderPreview();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// --- Preview ---
function renderPreview() {
  const sheet = currentSheet();
  const container = document.getElementById('preview-elements');
  container.innerHTML = '';
  if (!sheet || !sheet.candidates.length) return;

  const cand = sheet.candidates[currentPdfCandidateIdx];
  if (!cand) return;
  document.getElementById('preview-candidate-name').textContent = cand.name;

  state.draftLayout.forEach(el => {
    const div = buildPreviewElement(el, cand, sheet);
    container.appendChild(div);
  });
  container.appendChild(buildResultFooter(cand, sheet.settings));
}

function buildPreviewElement(el, cand, sheet) {
  const div = document.createElement('div');
  div.className = 'preview-element';
  div.style.cssText = `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;

  if (el.type === 'text') {
    const text = el.linkCol ? (cand.comments?.[el.linkCol] || '') : '';
    div.innerHTML = `<div class="preview-text-content" style="font-size:${el.fontSize || 12}px">${esc(text)}</div>`;
  } else if (el.type === 'name') {
    div.innerHTML = `<div class="preview-text-content auto-value" style="font-size:${el.fontSize || 22}px;font-weight:700">${esc(cand.name)}</div>`;
  } else if (el.type === 'date') {
    const dateText = sheet.examDate || '';
    div.innerHTML = `<div class="preview-text-content auto-value" style="font-size:${el.fontSize || 16}px">${esc(dateText)}</div>`;
  } else {
    const canvas = document.createElement('canvas');
    canvas.width  = el.w - 16;
    canvas.height = el.h - 16;
    div.innerHTML = `<div class="preview-chart-content"></div>`;
    div.querySelector('.preview-chart-content').appendChild(canvas);
    drawRadarChart(canvas, cand, sheet.settings);
  }
  return div;
}

function drawRadarChart(canvas, cand, settings) {
  const ctx    = canvas.getContext('2d');
  const items  = settings.items;
  const n      = items.length;
  const cx     = canvas.width  / 2;
  const cy     = canvas.height / 2;
  const r      = Math.min(cx, cy) - 28;
  const maxVal = Math.max(...settings.gradeScale.map(g => g.value));

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const steps = 5;

  // 同心多角形グリッド
  for (let s = 1; s <= steps; s++) {
    ctx.beginPath();
    ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 0.8;
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * i / n) - Math.PI / 2;
      const x = cx + (r * s / steps) * Math.cos(angle);
      const y = cy + (r * s / steps) * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.stroke();

    // 各リングに数値ラベル（軸の真上＝angle=-π/2 方向に表示）
    const axisAngle = -Math.PI / 2;
    const lx = cx + (r * s / steps) * Math.cos(axisAngle);
    const ly = cy + (r * s / steps) * Math.sin(axisAngle);
    const numLabel = ((maxVal * s) / steps).toFixed(1).replace(/\.0$/, '');
    ctx.fillStyle = '#9ca3af';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(numLabel, lx + 10, ly + 3);
  }

  // 軸線（中心から各頂点）
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    ctx.beginPath(); ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 0.8;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    ctx.stroke();
  }

  // 項目ラベル（大きめ・黒色）
  ctx.fillStyle = '#111827'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    const lx = cx + (r + 18) * Math.cos(angle);
    const ly = cy + (r + 18) * Math.sin(angle);
    ctx.fillText(items[i], lx, ly + 4);
  }

  // データポリゴン（塗りつぶしなし・線のみ）
  const scores = items.map(it => {
    const avg = calcItemAvgDirect(cand, it, settings);
    return avg !== null ? avg : 0;
  });
  ctx.beginPath(); ctx.strokeStyle = '#00B050'; ctx.lineWidth = 2;
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    const ratio = maxVal > 0 ? scores[i] / maxVal : 0;
    const x = cx + r * ratio * Math.cos(angle);
    const y = cy + r * ratio * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.stroke();

  // マーカー（各頂点に円）
  ctx.fillStyle = '#00B050';
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    const ratio = maxVal > 0 ? scores[i] / maxVal : 0;
    const x = cx + r * ratio * Math.cos(angle);
    const y = cy + r * ratio * Math.sin(angle);
    ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
  }
}

function calcItemAvgDirect(cand, item, settings) {
  let total = 0, count = 0;
  settings.examiners.forEach(ex => {
    const label = cand.examiners?.[ex]?.grades?.[item];
    const v = gradeValue(label, settings.gradeScale);
    if (v !== null && v !== undefined) { total += v; count++; }
  });
  return count ? total / count : null;
}

function buildResultFooter(cand, settings) {
  const div   = document.createElement('div');
  div.className = 'page-result-footer';
  const cells = settings.items.map(it => {
    const avg       = calcItemAvgDirect(cand, it, settings);
    const label     = avg !== null ? valueToLabel(avg, settings.gradeScale) : '-';
    const scoreText = avg !== null ? avg.toFixed(2) : '-';
    return `<div class="prf-item">` +
             `<span class="prf-name">${esc(it)}</span>` +
             `<span class="prf-grade">${esc(label)}</span>` +
             `<span class="prf-score">${esc(scoreText)}</span>` +
           `</div>`;
  }).join('');
  div.innerHTML = cells;
  return div;
}

// ===================== SCREEN 4 — PRINT PREVIEW =====================
let printActiveIdx = 0;

function goToPrint() {
  const sheet = currentSheet();
  if (!sheet || !sheet.candidates.length) return alert('受験者がいません');
  if (!state.draftLayout.length) return alert('PDF編集画面でレイアウトを作成してください');
  showScreen('print');
  renderPrintScreen();
}

function renderPrintScreen() {
  const sheet = currentSheet();
  if (!sheet) return;
  document.getElementById('print-sheet-title').textContent = sheet.name + '（印刷プレビュー）';

  if (printActiveIdx >= sheet.candidates.length) printActiveIdx = 0;

  const listEl = document.getElementById('print-candidate-list');
  listEl.innerHTML = sheet.candidates.map((c, i) =>
    `<button class="print-chip ${i === printActiveIdx ? 'active' : ''}" onclick="selectPrintCandidate(${i})">${esc(c.name)}</button>`
  ).join('');

  const stage = document.getElementById('print-stage');
  stage.innerHTML = '';
  sheet.candidates.forEach((cand, i) => {
    const page = document.createElement('div');
    page.className = 'print-page' + (i === printActiveIdx ? ' active-page' : '');
    page.dataset.idx = i;

    if (state.draftBgImage) {
      const bg = document.createElement('img');
      bg.className = 'draft-bg';
      bg.src = state.draftBgImage;
      page.appendChild(bg);
    }
    state.draftLayout.forEach(el => {
      page.appendChild(buildPreviewElement(el, cand, sheet));
    });
    page.appendChild(buildResultFooter(cand, sheet.settings));
    stage.appendChild(page);
  });
}

function selectPrintCandidate(i) {
  printActiveIdx = i;
  document.querySelectorAll('.print-chip').forEach((el, idx) => el.classList.toggle('active', idx === i));
  document.querySelectorAll('.print-page').forEach(p => {
    p.classList.toggle('active-page', Number(p.dataset.idx) === i);
  });
  const active = document.querySelector('.print-page.active-page');
  if (active) active.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function printOne() {
  document.body.classList.add('print-one');
  document.body.classList.remove('print-all');
  window.print();
  setTimeout(() => document.body.classList.remove('print-one'), 300);
}

function printAll() {
  document.body.classList.add('print-all');
  document.body.classList.remove('print-one');
  window.print();
  setTimeout(() => document.body.classList.remove('print-all'), 300);
}

// ===================== MODAL HELPERS =====================
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function closeModalOutside(e, id) { if (e.target.id === id) closeModal(id); }

// ===================== ESCAPE HELPERS =====================
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escStr(str) {
  return String(str ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}

// ===================== INIT =====================
async function initApp() {
  if (window.__appInitialized) return;
  window.__appInitialized = true;
  console.log('[App] 初期化開始');
  loadLocalState();

  showScreen('menu');
  document.getElementById('sheet-list').innerHTML =
    '<div class="empty-state"><p>読み込み中...</p></div>';

  try {
    await loadState();
    console.log('[App] Firestore 読み込み成功 / シート数:', state.sheets.length);
  } catch(e) {
    console.error('[App] Firestore 読み込みエラー:', e);
    document.getElementById('sheet-list').innerHTML =
      '<div class="empty-state" style="color:#dc2626"><p>Firestore の読み込みに失敗しました。<br>セキュリティルールを確認してください。<br>' + e.message + '</p></div>';
    return;
  }

  // リアルタイムリスナー開始（以降の変更は自動で反映）
  startSheetsListener();

  renderMenu();
  console.log('[App] 初期化完了 / シート数:', state.sheets.length);
}

// firebase-ready イベント（同期的に受け取れた場合）
window.addEventListener('firebase-ready', () => {
  if (!window.__appInitialized) initApp();
});

// type="module" と defer の実行順が保証されないため、
// window.__db が設定されるまでポーリングして確実に初期化する
(function waitForFirebase() {
  if (window.__db) {
    if (!window.__appInitialized) initApp();
  } else {
    setTimeout(waitForFirebase, 50);
  }
})();
