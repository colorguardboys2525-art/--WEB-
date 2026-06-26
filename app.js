/* ===========================
   ガード成績表管理 — app.js
=========================== */

// ===================== STATE =====================
let state = {
  sheets: [],          // [{id, name, createdAt, passHash, settings, candidates}]
  currentSheetId: null,
  adminPassHash: null,
  draftLayout: [],     // [{id, type, x, y, w, h, label, linkCol, fontSize}]
  draftBgImage: null,  // base64 or null
};

let selectedElementId = null;
let dragState = null;
let resizeState = null;
let currentPdfCandidateIdx = 0;
let editingLinkElementId = null;

// Pending sheet ids for password-gated actions
let pendingUnlockSheetId = null;
let pendingDeleteSheetId = null;

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

// ===================== PERSISTENCE (Firestore) =====================
// Firestore ヘルパーは index.html の <script type="module"> が
// window.__db などとしてグローバルに公開する。

function _db()              { return window.__db; }
function _doc(...args)      { return window.__fsDoc(...args); }
function _getDoc(ref)       { return window.__fsGetDoc(ref); }
function _setDoc(ref, d)    { return window.__fsSetDoc(ref, d); }
function _delDoc(ref)       { return window.__fsDeleteDoc(ref); }
function _col(...args)      { return window.__fsCollection(...args); }
function _getDocs(ref)      { return window.__fsGetDocs(ref); }

// シート1件を Firestore に保存 (fire-and-forget)
function saveSheet(sheet) {
  if (!_db()) return;
  _setDoc(_doc(_db(), 'sheets', sheet.id), JSON.parse(JSON.stringify(sheet)))
    .catch(e => console.error('saveSheet:', e));
}

// グローバル設定（adminPassHash / draftLayout / draftBgImage / currentSheetId）を保存
function saveConfig() {
  if (!_db()) return;
  const cfg = {
    adminPassHash:  state.adminPassHash  ?? null,
    currentSheetId: state.currentSheetId ?? null,
    draftLayout:    JSON.parse(JSON.stringify(state.draftLayout)),
    draftBgImage:   state.draftBgImage   ?? null,
  };
  _setDoc(_doc(_db(), 'config', 'meta'), cfg)
    .catch(e => console.error('saveConfig:', e));
}

// saveState() を呼んでいた箇所の互換関数：
// シートの変更後は saveSheet(currentSheet()) を、
// レイアウト/設定変更後は saveConfig() を呼ぶ。
// ここでは両方まとめて保存する簡易版。
function saveState() {
  const sheet = currentSheet();
  if (sheet) saveSheet(sheet);
  saveConfig();
}

// 全データを Firestore から読み込む（アプリ起動時のみ）
async function loadState() {
  if (!_db()) return;

  // グローバル設定
  try {
    const snap = await _getDoc(_doc(_db(), 'config', 'meta'));
    if (snap.exists()) {
      const d = snap.data();
      state.adminPassHash  = d.adminPassHash  ?? null;
      state.currentSheetId = d.currentSheetId ?? null;
      state.draftLayout    = d.draftLayout    ?? [];
      state.draftBgImage   = d.draftBgImage   ?? null;
    }
  } catch(e) { console.error('loadState config:', e); }

  // シート一覧
  try {
    const snaps = await _getDocs(_col(_db(), 'sheets'));
    state.sheets = [];
    snaps.forEach(s => state.sheets.push(s.data()));
    // 作成日降順
    state.sheets.sort((a, b) => (b.createdAt || '') > (a.createdAt || '') ? 1 : -1);
  } catch(e) { console.error('loadState sheets:', e); }
}

// ===================== HELPERS =====================
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function currentSheet() { return state.sheets.find(s => s.id === state.currentSheetId) || null; }

// SHA-256 hash (Web Crypto). Returns hex string. Salted with a fixed app salt.
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
  const sorted = [...gradeScale].sort((a, b) => b.value - a.value);
  for (const g of sorted) {
    if (value >= g.value) return g.label;
  }
  return sorted[sorted.length - 1]?.label || '-';
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
  const name = nameEl.value.trim();
  const pass = passEl.value;
  if (!name) { nameEl.focus(); return; }
  if (!pass) { alert('パスワードを設定してください。'); passEl.focus(); return; }

  const sheet = {
    id: uid(), name,
    createdAt: new Date().toLocaleDateString('ja-JP'),
    passHash: await hashPassword(pass),
    settings: DEFAULT_SETTINGS(),
    candidates: [],
  };
  state.sheets.unshift(sheet);
  nameEl.value = '';
  passEl.value = '';
  saveSheet(sheet);
  saveConfig();
  renderMenu();
}

// --- Open sheet: requires the sheet password ---
function openSheet(id) {
  const sheet = state.sheets.find(s => s.id === id);
  if (!sheet) return;
  // Backward compatibility: sheets without a passHash open directly
  if (!sheet.passHash) {
    state.currentSheetId = id;
    saveState();
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
    saveConfig();
    closeModal('modal-unlock');
    goToGrade();
  } else {
    document.getElementById('unlock-error').style.display = '';
    document.getElementById('unlock-pass').value = '';
    document.getElementById('unlock-pass').focus();
  }
}

// --- Delete sheet: requires the admin password ---
function deleteSheet(id) {
  const sheet = state.sheets.find(s => s.id === id);
  if (!sheet) return;
  // If admin password is not yet set, prompt to set it up first
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
    state.sheets = state.sheets.filter(s => s.id !== deletedId);
    pendingDeleteSheetId = null;
    // Firestore からも削除
    if (_db()) _delDoc(_doc(_db(), 'sheets', deletedId))
      .catch(e => console.error('deleteSheet Firestore:', e));
    saveConfig();
    closeModal('modal-delete');
    renderMenu();
  } else {
    document.getElementById('delete-error').style.display = '';
    document.getElementById('delete-pass').value = '';
    document.getElementById('delete-pass').focus();
  }
}

// --- Admin password setup ---
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
  saveConfig();
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
  const { settings, candidates } = sheet;
  const thead = document.getElementById('grade-thead');
  const tbody = document.getElementById('grade-tbody');

  // Header
  let hrow = `<tr>
    <th rowspan="2" style="vertical-align:middle">受験者</th>
    <th rowspan="2" style="vertical-align:middle">試験官</th>
    ${settings.items.map(it => `<th>${esc(it)}</th>`).join('')}
    <th rowspan="2" class="col-avg" style="vertical-align:middle">平均評価</th>
    ${settings.comments.map(c => `<th class="col-comment">${esc(c)}</th>`).join('')}
    <th rowspan="2" class="col-action" style="vertical-align:middle">操作</th>
  </tr>`;
  thead.innerHTML = hrow;

  // Body
  if (!candidates.length) {
    tbody.innerHTML = `<tr><td colspan="${2 + settings.items.length + 1 + settings.comments.length + 1}" style="text-align:center;padding:32px;color:#9ca3af">受験者を追加ボタン、または一括入力ボタンから追加してください</td></tr>`;
    return;
  }

  let html = '';
  candidates.forEach((cand, ci) => {
    // ensure structure
    if (!cand.examiners) cand.examiners = {};
    settings.examiners.forEach(ex => {
      if (!cand.examiners[ex]) cand.examiners[ex] = { grades: {}, };
      settings.items.forEach(it => {
        if (!cand.examiners[ex].grades[it]) cand.examiners[ex].grades[it] = '';
      });
    });
    if (!cand.comments) cand.comments = {};
    settings.comments.forEach(c => { if (!cand.comments[c]) cand.comments[c] = ''; });

    const rowspan = settings.examiners.length + 1; // examiners + avg row

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

    // avg row
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
  saveState();
  // update avg cells without full re-render
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

// Import candidates
function openImportModal() { openModal('modal-import'); }

// Add single candidate
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

// Delete a candidate
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
// temp storage while editing
let tempSettings = null;
let origSettings = null; // snapshot of names before editing (for remapping)

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
  // Examiners
  renderEditList('examiner-list', tempSettings.examiners, 'examiner');
  // Items
  renderEditList('item-list', tempSettings.items, 'item');
  // Comments
  renderEditList('comment-list', tempSettings.comments, 'comment');
  // Grade scale
  renderGradeScaleList();
}

// Editable list: each entry is a text input that can be renamed + a remove button
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
  // no full re-render needed; value already in input
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

  // Remap candidate data when names were renamed (only when count is unchanged,
  // so index-based old->new mapping is reliable).
  if (origSettings) {
    remapCandidateKeys(sheet, 'examiner', origSettings.examiners, tempSettings.examiners);
    remapCandidateKeys(sheet, 'item', origSettings.items, tempSettings.items);
    remapCandidateKeys(sheet, 'comment', origSettings.comments, tempSettings.comments);
    // Remap text-box links that referenced a renamed comment column
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
  origSettings = null;
  saveState();
  closeModal('modal-settings');
  renderGradeScreen();
}

// Rename keys inside each candidate's stored data so existing grades/comments
// follow a renamed examiner/item/comment column.
function remapCandidateKeys(sheet, kind, oldArr, newArr) {
  if (oldArr.length !== newArr.length) return; // counts changed: skip (ambiguous)
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

  // Candidate list
  const listEl = document.getElementById('pdf-candidate-list');
  if (!sheet.candidates.length) {
    listEl.innerHTML = '<div class="hint">受験者なし</div>';
  } else {
    listEl.innerHTML = sheet.candidates.map((c, i) =>
      `<div class="candidate-item ${i === currentPdfCandidateIdx ? 'active' : ''}" onclick="selectPdfCandidate(${i})">${esc(c.name)}</div>`
    ).join('');
  }

  // Restore draft bg
  const bgImg = document.getElementById('draft-bg-img');
  const prevBg = document.getElementById('preview-bg-img');
  if (state.draftBgImage) {
    bgImg.src = state.draftBgImage; bgImg.style.display = '';
    prevBg.src = state.draftBgImage; prevBg.style.display = '';
  } else {
    bgImg.style.display = 'none'; prevBg.style.display = 'none';
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
    bodyHtml = `<div class="chart-placeholder"><span>&#128202;</span><span>レーダーチャート</span></div>`;
  } else if (el.type === 'name') {
    typeLabel = '受験者名';
    bodyHtml = `<div class="auto-field-note">&#128100; 受験者の名前が自動で入ります</div>`;
  } else if (el.type === 'date') {
    typeLabel = '受験日';
    bodyHtml = `<div class="auto-field-note">&#128197; 受験日が自動で入ります</div>`;
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

  // Drag
  const header = div.querySelector('.draft-element-header');
  header.addEventListener('mousedown', e => startDrag(e, el.id, div));
  // Resize
  const handle = div.querySelector('.resize-handle');
  handle.addEventListener('mousedown', e => startResize(e, el.id, div));

  return div;
}

function addTextBox() {
  const el = { id: uid(), type: 'text', x: 40, y: 40, w: 220, h: 80, label: 'テキストボックス', linkCol: '', fontSize: 12 };
  state.draftLayout.push(el);
  saveState();
  renderDraftElements();
  renderPreview();
}

function addNameBox() {
  const el = { id: uid(), type: 'name', x: 40, y: 40, w: 240, h: 56, label: '受験者名', fontSize: 22 };
  state.draftLayout.push(el);
  saveState();
  renderDraftElements();
  renderPreview();
}

function addDateBox() {
  const el = { id: uid(), type: 'date', x: 40, y: 110, w: 200, h: 48, label: '受験日', fontSize: 16 };
  state.draftLayout.push(el);
  saveState();
  renderDraftElements();
  renderPreview();
}

function addChartBox() {
  const el = { id: uid(), type: 'chart', x: 200, y: 200, w: 260, h: 220, label: 'レーダーチャート' };
  state.draftLayout.push(el);
  saveState();
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
    saveState();
    const bgImg = document.getElementById('draft-bg-img');
    bgImg.src = state.draftBgImage; bgImg.style.display = '';
    const prevBg = document.getElementById('preview-bg-img');
    prevBg.src = state.draftBgImage; prevBg.style.display = '';
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function clearDraft() {
  if (!confirm('下書きのすべての要素を削除しますか？')) return;
  state.draftLayout = [];
  state.draftBgImage = null;
  saveState();
  renderDraftElements();
  const bgImg = document.getElementById('draft-bg-img');
  bgImg.style.display = 'none';
  const prevBg = document.getElementById('preview-bg-img');
  prevBg.style.display = 'none';
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
    document.getElementById('tb-label').value = el.label || '';
    document.getElementById('tb-fontsize').value = el.fontSize || 12;
    openModal('modal-link');
  } else if (el.type === 'chart') {
    document.getElementById('chart-label').value = el.label || '';
    openModal('modal-chart-link');
  } else {
    // name / date auto field
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
  saveState();
  closeModal('modal-field');
  renderDraftElements();
  renderPreview();
}

function saveTextBoxLink() {
  const el = state.draftLayout.find(e => e.id === editingLinkElementId);
  if (!el) return;
  el.label = document.getElementById('tb-label').value;
  el.linkCol = document.getElementById('tb-link-col').value;
  el.fontSize = parseInt(document.getElementById('tb-fontsize').value) || 12;
  saveState();
  closeModal('modal-link');
  renderDraftElements();
  renderPreview();
}

function saveChartLink() {
  const el = state.draftLayout.find(e => e.id === editingLinkElementId);
  if (!el) return;
  el.label = document.getElementById('chart-label').value;
  saveState();
  closeModal('modal-chart-link');
  renderDraftElements();
  renderPreview();
}

function deleteElement() {
  state.draftLayout = state.draftLayout.filter(e => e.id !== editingLinkElementId);
  saveState();
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

  const el = state.draftLayout.find(e2 => e2.id === elId);
  const canvas = document.getElementById('a4-canvas').getBoundingClientRect();
  const startX = e.clientX - canvas.left - el.x;
  const startY = e.clientY - canvas.top - el.y;

  function onMove(ev) {
    const x = Math.max(0, Math.min(794 - el.w, ev.clientX - canvas.left - startX));
    const y = Math.max(0, Math.min(1123 - el.h, ev.clientY - canvas.top - startY));
    el.x = Math.round(x); el.y = Math.round(y);
    div.style.left = el.x + 'px'; div.style.top = el.y + 'px';
  }
  function onUp() {
    saveState();
    renderPreview();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// --- Resize ---
function startResize(e, elId, div) {
  e.preventDefault(); e.stopPropagation();
  const el = state.draftLayout.find(e2 => e2.id === elId);
  const canvas = document.getElementById('a4-canvas').getBoundingClientRect();
  const startX = e.clientX; const startY = e.clientY;
  const startW = el.w; const startH = el.h;

  function onMove(ev) {
    el.w = Math.max(80, Math.min(794 - el.x, startW + ev.clientX - startX));
    el.h = Math.max(40, Math.min(1123 - el.y, startH + ev.clientY - startY));
    div.style.width = el.w + 'px'; div.style.height = el.h + 'px';
  }
  function onUp() {
    saveState();
    renderPreview();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
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

// Build a single rendered element (used by preview + print pages).
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
    // radar chart
    const canvas = document.createElement('canvas');
    canvas.width = el.w - 16; canvas.height = el.h - 16;
    div.innerHTML = `<div class="preview-chart-content"></div>`;
    div.querySelector('.preview-chart-content').appendChild(canvas);
    drawRadarChart(canvas, cand, sheet.settings);
  }
  return div;
}

function drawRadarChart(canvas, cand, settings) {
  const ctx = canvas.getContext('2d');
  const items = settings.items;
  const n = items.length;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r = Math.min(cx, cy) - 24;
  const maxVal = Math.max(...settings.gradeScale.map(g => g.value));

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Grid
  const steps = 5;
  for (let s = 1; s <= steps; s++) {
    ctx.beginPath();
    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * i / n) - Math.PI / 2;
      const x = cx + (r * s / steps) * Math.cos(angle);
      const y = cy + (r * s / steps) * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
  }

  // Spokes
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    ctx.beginPath(); ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    ctx.stroke();
  }

  // Labels
  ctx.fillStyle = '#374151'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    const lx = cx + (r + 14) * Math.cos(angle);
    const ly = cy + (r + 14) * Math.sin(angle);
    ctx.fillText(items[i], lx, ly + 4);
  }

  // Data polygon
  const scores = items.map(it => {
    const avg = calcItemAvgDirect(cand, it, settings);
    return avg !== null ? avg : 0;
  });
  ctx.beginPath(); ctx.strokeStyle = '#00B050'; ctx.lineWidth = 2;
  ctx.fillStyle = 'rgba(0,176,80,.18)';
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    const ratio = maxVal > 0 ? scores[i] / maxVal : 0;
    const x = cx + r * ratio * Math.cos(angle);
    const y = cy + r * ratio * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();

  // Dots
  ctx.fillStyle = '#00B050';
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    const ratio = maxVal > 0 ? scores[i] / maxVal : 0;
    const x = cx + r * ratio * Math.cos(angle);
    const y = cy + r * ratio * Math.sin(angle);
    ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fill();
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

// Build the result footer strip showing each item's average value + grade label.
function buildResultFooter(cand, settings) {
  const div = document.createElement('div');
  div.className = 'page-result-footer';
  const cells = settings.items.map(it => {
    const avg = calcItemAvgDirect(cand, it, settings);
    const label = avg !== null ? valueToLabel(avg, settings.gradeScale) : '-';
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

  // Candidate selector chips
  const listEl = document.getElementById('print-candidate-list');
  listEl.innerHTML = sheet.candidates.map((c, i) =>
    `<button class="print-chip ${i === printActiveIdx ? 'active' : ''}" onclick="selectPrintCandidate(${i})">${esc(c.name)}</button>`
  ).join('');

  // Build one A4 page per candidate
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
  // scroll the chosen page into view
  const active = document.querySelector('.print-page.active-page');
  if (active) active.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Print only the currently selected candidate
function printOne() {
  document.body.classList.add('print-one');
  document.body.classList.remove('print-all');
  window.print();
  setTimeout(() => document.body.classList.remove('print-one'), 300);
}

// Print all candidates (one A4 page each)
function printAll() {
  document.body.classList.add('print-all');
  document.body.classList.remove('print-one');
  window.print();
  setTimeout(() => document.body.classList.remove('print-all'), 300);
}

// ===================== MODAL HELPERS =====================
function openModal(id) { document.getElementById(id).classList.add('open'); }
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
// Firebase SDK の準備完了イベントを待ってから起動する。
// index.html の <script type="module"> が firebase-ready を dispatch する。
async function initApp() {
  showScreen('menu');
  document.getElementById('sheet-list').innerHTML =
    '<div class="empty-state"><p>読み込み中...</p></div>';
  await loadState();
  renderMenu();
}

window.addEventListener('firebase-ready', () => initApp());
