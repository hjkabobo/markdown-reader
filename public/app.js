'use strict';

// md-reader 前端邏輯：清單、渲染、TOC、搜尋、釘選、排序、主題、CSV、編輯、即時更新、內部連結。

const el = {
  tree: document.getElementById('tree'),
  doc: document.getElementById('doc'),
  toc: document.getElementById('toc'),
  content: document.getElementById('content'),
  search: document.getElementById('search'),
  searchClear: document.getElementById('search-clear'),
  searchResults: document.getElementById('search-results'),
  themeBtn: document.getElementById('theme-btn'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebarExpand: document.getElementById('sidebar-expand'),
  sortSeg: document.getElementById('sort-seg'),
  pins: document.getElementById('pins'),
  pinsList: document.getElementById('pins-list'),
  editor: document.getElementById('editor'),
  editorInput: document.getElementById('editor-input'),
  editorPath: document.getElementById('editor-path'),
  editorPreview: document.getElementById('editor-preview'),
  editorStatus: document.getElementById('editor-status'),
  editorSave: document.getElementById('editor-save'),
  editorCancel: document.getElementById('editor-cancel'),
  newFileBtn: document.getElementById('new-file-btn'),
  newFileModal: document.getElementById('new-file-modal'),
  newFilePath: document.getElementById('new-file-path'),
  newFileError: document.getElementById('new-file-error'),
  newFileOk: document.getElementById('new-file-ok'),
  newFileCancel: document.getElementById('new-file-cancel'),
};

let activeFileEl = null;
let treeData = null;                       // 快取 /api/tree 結果，切換排序/釘選不必重抓
let state = { sort: 'name', pins: [] };    // 個人設定（存在 server 的 .reader-state.json）
let pinSet = new Set();                     // 快速查詢用：pinKey -> 是否釘選
let fileIndex = [];                         // 攤平的檔案索引：{ root, rel, name }，給「檔案提及轉連結」比對用
let editableRoots = new Set();              // 可編輯的 root id（三個 repo；memory／Codex 唯讀）

// 簡約線條圖示（底色由 CSS 用 var(--accent) 控制；外框 currentColor 跟著文字色）
const ICON_FOLDER = '<svg class="icon" viewBox="0 0 16 16" width="15" height="15" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.9 4.4h3.3l1 1.3h6.1c.55 0 .9.35.9.9v5.2c0 .55-.35.9-.9.9H2.8c-.55 0-.9-.35-.9-.9V4.4z"/></svg>';
const ICON_FILE = '<svg class="icon" viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 2h4.6l2.9 2.9v8.6c0 .28-.22.5-.5.5H4.2c-.28 0-.5-.22-.5-.5V2.5c0-.28.22-.5.5-.5z"/><path fill="none" d="M8.6 2v3.1h3"/></svg>';
const ICON_CSV = '<svg class="icon icon-csv" viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 2h4.6l2.9 2.9v8.6c0 .28-.22.5-.5.5H4.2c-.28 0-.5-.22-.5-.5V2.5c0-.28.22-.5.5-.5z"/><path fill="none" d="M8.6 2v3.1h3"/></svg>';
// 鉛筆圖示（用編輯器開啟）
const ICON_EDIT = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.2l3.3 3.3M2.5 13.5l.9-3.3 7-7c.4-.4 1-.4 1.4 0l1.9 1.9c.4.4.4 1 0 1.4l-7 7-3.2.9z"/></svg>';

// ---------- marked ----------
marked.setOptions({ gfm: true, breaks: false });

// ---------- 主題 ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('hljs-light').disabled = theme === 'dark';
  document.getElementById('hljs-dark').disabled = theme !== 'dark';
  localStorage.setItem('md-theme', theme);
}
el.themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});
applyTheme(localStorage.getItem('md-theme') || 'light');

// ---------- 左側清單收合 ----------
function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  el.sidebarExpand.hidden = !collapsed;
  localStorage.setItem('md-sidebar-collapsed', collapsed ? '1' : '0');
}
el.sidebarToggle.addEventListener('click', () => applySidebarCollapsed(true));
el.sidebarExpand.addEventListener('click', () => applySidebarCollapsed(false));
applySidebarCollapsed(localStorage.getItem('md-sidebar-collapsed') === '1');

// ---------- 個人設定（釘選 / 排序）----------
function pinKey(type, root, rel) { return type + '|' + root + '|' + rel; }

function rebuildPinSet() {
  pinSet = new Set(state.pins.map((p) => pinKey(p.type, p.root, p.rel)));
}

async function loadState() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    state.sort = data.sort === 'mtime' ? 'mtime' : 'name';
    state.pins = Array.isArray(data.pins) ? data.pins : [];
  } catch {}
  rebuildPinSet();
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(() => {});
  }, 150);
}

function isPinned(type, root, rel) { return pinSet.has(pinKey(type, root, rel)); }

function togglePin(type, root, rel, name) {
  const key = pinKey(type, root, rel);
  if (pinSet.has(key)) {
    pinSet.delete(key);
    state.pins = state.pins.filter((p) => pinKey(p.type, p.root, p.rel) !== key);
  } else {
    pinSet.add(key);
    state.pins.push({ type, root, rel, name });
  }
  saveState();
  // 更新所有同一目標的星星外觀，並重畫釘選區
  document.querySelectorAll('.star[data-key="' + cssAttr(key) + '"]').forEach((b) => {
    b.classList.toggle('pinned', pinSet.has(key));
    b.title = pinSet.has(key) ? '取消釘選' : '釘選';
  });
  renderPins();
}

function cssAttr(s) { return s.replace(/"/g, '\\"'); }

// 建立一顆星星按鈕
function makeStar(type, root, rel, name) {
  const star = document.createElement('button');
  star.className = 'star' + (isPinned(type, root, rel) ? ' pinned' : '');
  star.dataset.key = pinKey(type, root, rel);
  star.title = isPinned(type, root, rel) ? '取消釘選' : '釘選';
  star.textContent = '★';
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePin(type, root, rel, name);
  });
  return star;
}

// ---------- 載入樹 ----------
async function loadTree() {
  const res = await fetch('/api/tree');
  treeData = await res.json();
  fileIndex = buildFileIndex();
  editableRoots = new Set(treeData.roots.filter((r) => r.editable).map((r) => r.id));
  render();
}

function isEditableRoot(rootId) {
  return editableRoots.has(rootId);
}

// 把樹狀結構攤平成一維陣列，方便找「文中提到的路徑」對應到哪個檔案
function buildFileIndex() {
  const idx = [];
  if (!treeData) return idx;
  for (const root of treeData.roots) {
    const walk = (node) => {
      for (const f of node.files) idx.push({ root: root.id, rel: f.rel, name: f.name });
      for (const d of node.dirs) walk(d);
    };
    walk(root);
  }
  return idx;
}

// 依目前排序模式重畫清單
function render() {
  // 排序按鈕狀態
  el.sortSeg.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.sort === state.sort));
  renderPins();
  if (state.sort === 'mtime') renderRecent();
  else renderByName();
  restoreActive();
}

// 名稱排序（階層）：第一層檔案在前、資料夾在後；子層資料夾在前、檔案在後
function renderByName() {
  el.tree.innerHTML = '';
  for (const root of treeData.roots) {
    const group = document.createElement('div');
    group.className = 'root-group';
    const label = document.createElement('div');
    label.className = 'root-label';
    label.textContent = root.label;
    group.appendChild(label);
    group.appendChild(renderDir({ dirs: root.dirs, files: root.files }, root.id));
    el.tree.appendChild(group);
  }
}

function renderDir(node, rootId) {
  // 每一層都是資料夾在前、檔案在後
  const frag = document.createDocumentFragment();
  frag.appendChild(renderDirs(node.dirs, rootId));
  frag.appendChild(renderFiles(node.files, rootId));
  return frag;
}

function renderDirs(dirs, rootId) {
  const frag = document.createDocumentFragment();
  for (const dir of dirs) {
    const dirEl = document.createElement('div');
    dirEl.className = 'node-dir collapsed';
    dirEl.dataset.type = 'dir';
    dirEl.dataset.root = rootId;
    dirEl.dataset.rel = dir.rel;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<span class="caret">▾</span>' + ICON_FOLDER + '<span class="label-text"></span>';
    row.querySelector('.label-text').textContent = dir.name;
    row.appendChild(makeStar('dir', rootId, dir.rel, dir.name));
    row.addEventListener('click', () => dirEl.classList.toggle('collapsed'));
    const children = document.createElement('div');
    children.className = 'children';
    children.appendChild(renderDir({ dirs: dir.dirs, files: dir.files }, rootId));
    dirEl.appendChild(row);
    dirEl.appendChild(children);
    frag.appendChild(dirEl);
  }
  return frag;
}

function renderFiles(files, rootId) {
  const frag = document.createDocumentFragment();
  for (const file of files) {
    frag.appendChild(makeFileRow(rootId, file.rel, file.name, file.type));
  }
  return frag;
}

function makeFileRow(rootId, rel, name, fileType) {
  const fileEl = document.createElement('div');
  fileEl.className = 'node-file';
  fileEl.dataset.type = 'file';
  fileEl.dataset.root = rootId;
  fileEl.dataset.rel = rel;
  const icon = fileType === 'csv' ? ICON_CSV : ICON_FILE;
  fileEl.innerHTML = '<span class="caret" style="visibility:hidden">·</span>' + icon + '<span class="label-text"></span>';
  fileEl.querySelector('.label-text').textContent = name.replace(/\.(md|markdown|mdown|csv)$/i, '');
  fileEl.title = name;
  fileEl.appendChild(makeStar('file', rootId, rel, name));
  fileEl.addEventListener('click', () => openFile(rootId, rel, fileEl));
  return fileEl;
}

// 最近修改排序：所有檔案攤平、依修改時間新到舊
function renderRecent() {
  el.tree.innerHTML = '';
  const all = [];
  for (const root of treeData.roots) {
    const walk = (node) => {
      for (const f of node.files) all.push({ root: root.id, rootLabel: root.label, ...f });
      for (const d of node.dirs) walk(d);
    };
    walk(root);
  }
  all.sort((a, b) => b.mtime - a.mtime);
  const list = document.createElement('div');
  list.className = 'recent-list';
  for (const f of all) {
    const row = document.createElement('div');
    row.className = 'node-file recent-row';
    row.dataset.type = 'file';
    row.dataset.root = f.root;
    row.dataset.rel = f.rel;
    const icon = f.type === 'csv' ? ICON_CSV : ICON_FILE;
    row.innerHTML = icon +
      '<div class="recent-main"><div class="label-text"></div><div class="recent-path"></div></div>' +
      '<span class="recent-date"></span>';
    row.querySelector('.label-text').textContent = f.name.replace(/\.(md|markdown|mdown|csv)$/i, '');
    row.querySelector('.recent-path').textContent = f.rootLabel + ' / ' + f.rel;
    row.querySelector('.recent-date').textContent = relTime(f.mtime);
    row.appendChild(makeStar('file', f.root, f.rel, f.name));
    row.addEventListener('click', () => openFile(f.root, f.rel, row));
    list.appendChild(row);
  }
  el.tree.appendChild(list);
}

function relTime(ms) {
  const diff = Date.now() - ms;
  const day = 86400000;
  if (diff < day) return '今天';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return Math.floor(diff / day) + ' 天前';
  const d = new Date(ms);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

// ---------- 釘選區 ----------
function rootLabelOf(id) {
  const r = treeData && treeData.roots.find((x) => x.id === id);
  return r ? r.label : id;
}

function renderPins() {
  if (!state.pins.length) { el.pins.hidden = true; el.pinsList.innerHTML = ''; return; }
  el.pins.hidden = false;
  el.pinsList.innerHTML = '';
  for (const p of state.pins) {
    const row = document.createElement('div');
    row.className = 'pin-row';
    const icon = p.type === 'dir' ? ICON_FOLDER : ICON_FILE;
    row.innerHTML = icon + '<div class="pin-main"><div class="label-text"></div><div class="pin-path"></div></div>';
    row.querySelector('.label-text').textContent = (p.name || p.rel).replace(/\.(md|markdown|mdown|csv)$/i, '');
    // 顯示所在位置（repo / 上層資料夾），讓同名檔案分得出來
    const parent = p.rel.split('/').slice(0, -1).join('/');
    row.querySelector('.pin-path').textContent = rootLabelOf(p.root) + (parent ? ' / ' + parent : '');
    row.title = p.rel;
    const star = makeStar(p.type, p.root, p.rel, p.name);
    row.appendChild(star);
    row.addEventListener('click', () => {
      if (p.type === 'file') openFile(p.root, p.rel, null);
      else revealDir(p.root, p.rel);
    });
    el.pinsList.appendChild(row);
  }
}

// 點釘選的資料夾：切回名稱排序、展開並捲到該資料夾
function revealDir(root, rel) {
  if (state.sort !== 'name') { state.sort = 'name'; saveState(); render(); }
  const sel = '.node-dir[data-type="dir"][data-root="' + cssAttr(root) + '"][data-rel="' + cssAttr(rel) + '"]';
  const dirEl = el.tree.querySelector(sel);
  if (!dirEl) return;
  let p = dirEl;
  while (p && p !== el.tree) {
    if (p.classList && p.classList.contains('node-dir')) p.classList.remove('collapsed');
    p = p.parentElement;
  }
  dirEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  dirEl.querySelector('.row').classList.add('flash');
  setTimeout(() => dirEl.querySelector('.row').classList.remove('flash'), 1200);
}

// 重畫後把目前開啟的檔案標記回 active
let currentDoc = null;       // { root, rel, content, mtime, type } — content 永遠是磁碟上的最新版
let isEditing = false;
let isDirty = false;         // 編輯區內容跟 currentDoc.content 不一樣
let suppressReloadUntil = 0; // 自己剛存過檔，這段時間內忽略 SSE 的重新載入

function restoreActive() {
  activeFileEl = null;
  if (!currentDoc) return;
  const sel = '.node-file[data-type="file"][data-root="' + cssAttr(currentDoc.root) + '"][data-rel="' + cssAttr(currentDoc.rel) + '"]';
  const node = el.tree.querySelector(sel);
  if (node) { node.classList.add('active'); activeFileEl = node; }
}

// ---------- 上一頁 ----------
//
// openFile 尾端會把 root::rel 寫進 location.hash，瀏覽器就自動記下歷史；
// 這一段負責倒回來的另外半邊：hash 一變就把對應的檔案開回來。
// 文件內文的 #標題 錨點也會改 hash，所以只認得出 '::' 的才當成換檔案。

const scrollMemory = new Map();  // 'root::rel' -> 離開時的捲動位置
let ignoreHashChange = false;    // 自己寫的 hash 不要再回頭觸發自己

function docKey(root, rel) { return root + '::' + rel; }

function setHash(root, rel) {
  const h = '#' + encodeURIComponent(docKey(root, rel));
  if (location.hash === h) return;  // 沒變就不寫，免得旗標留在 true 吃掉下一次事件
  ignoreHashChange = true;
  location.hash = h;
}

window.addEventListener('hashchange', () => {
  if (ignoreHashChange) { ignoreHashChange = false; return; }
  const raw = decodeURIComponent(location.hash.slice(1));
  const sep = raw.indexOf('::');
  if (sep < 0) return;
  const root = raw.slice(0, sep);
  const rel = raw.slice(sep + 2);
  if (currentDoc && currentDoc.root === root && currentDoc.rel === rel) return;
  openFile(root, rel, null);
});

// ---------- 開啟並渲染檔案 ----------
async function openFile(rootId, rel, fileEl, query) {
  // 編輯中還有沒存的東西，換檔案前先問一聲
  if (isEditing && isDirty && !(currentDoc && currentDoc.root === rootId && currentDoc.rel === rel)) {
    if (!confirm('這份檔案有還沒儲存的修改，確定要離開嗎？')) {
      // 如果是按上一頁進來的，網址列已經退掉了，推回目前這份檔案讓兩邊對得上
      setHash(currentDoc.root, currentDoc.rel);
      return;
    }
  }
  // 離開前記住捲到哪，回來才不用重找
  if (currentDoc && !(currentDoc.root === rootId && currentDoc.rel === rel)) {
    scrollMemory.set(docKey(currentDoc.root, currentDoc.rel), el.content.scrollTop);
  }
  if (isEditing) exitEdit(true);

  const res = await fetch('/api/file?root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(rel));
  const data = await res.json();
  if (data.error) {
    el.doc.innerHTML = '<div class="empty-state"><p>無法開啟：' + escapeHtml(data.error) + '</p></div>';
    return;
  }
  currentDoc = { root: rootId, rel, content: data.content, mtime: data.mtime, type: data.type };

  if (activeFileEl) activeFileEl.classList.remove('active');
  if (!fileEl) {
    const sel = '.node-file[data-type="file"][data-root="' + cssAttr(rootId) + '"][data-rel="' + cssAttr(rel) + '"]';
    fileEl = el.tree.querySelector(sel);
  }
  if (fileEl) {
    fileEl.classList.add('active');
    activeFileEl = fileEl;
    let p = fileEl.parentElement;
    while (p && p !== el.tree) {
      if (p.classList && p.classList.contains('node-dir')) p.classList.remove('collapsed');
      p = p.parentElement;
    }
  }

  if (data.type === 'csv') {
    renderCsv(data, rel, data.mtime, rootId);
  } else {
    renderMarkdown(data, rel, rootId, query);
  }

  const savedScroll = scrollMemory.get(docKey(rootId, rel)) || 0;
  el.content.scrollTop = savedScroll;
  // 圖片、mermaid 這些算完高度會把版面推掉，下一幀再校正一次
  if (savedScroll) requestAnimationFrame(() => { el.content.scrollTop = savedScroll; });
  setHash(rootId, rel);
  document.title = data.name + ' — Markdown 閱讀器';
}

function renderMarkdown(data, rel, rootId, query) {
  const dirty = marked.parse(data.content);
  const clean = DOMPurify.sanitize(dirty, { ADD_ATTR: ['id'] });
  const metaStr = '最後修改：' + new Date(data.mtime).toLocaleString('zh-TW');
  const editBtnHtml = isEditableRoot(rootId)
    ? '<button class="edit-btn" title="在閱讀器裡編輯（⌘S 存檔）">' + ICON_EDIT + '<span>編輯</span></button>'
    : '';
  el.doc.innerHTML =
    '<div class="doc-meta"><span class="doc-meta-info">' + escapeHtml(rel) + ' · ' + metaStr + '</span>' +
    '<button class="open-btn" title="用系統預設編輯器開啟原始檔"><span>用編輯器開啟</span></button>' +
    '<button class="pdf-btn" title="只列印中間內文，另存為 PDF"><span>下載 PDF</span></button>' +
    editBtnHtml + '</div>' + clean;

  const editBtn = el.doc.querySelector('.edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => enterEdit());

  const openBtn = el.doc.querySelector('.open-btn');
  if (openBtn) openBtn.addEventListener('click', () => openInEditor(rootId, rel, openBtn));

  const pdfBtn = el.doc.querySelector('.pdf-btn');
  if (pdfBtn) pdfBtn.addEventListener('click', () => window.print());

  el.doc.querySelectorAll('pre code').forEach((block) => {
    try { hljs.highlightElement(block); } catch {}
  });

  wireImages(el.doc, rootId, rel);
  addHeadingIds();
  rewireMarkdownLinks(rootId, rel);
  linkifyMentions(rootId);
  if (isEditableRoot(rootId)) wireTaskCheckboxes();
  buildToc();

  if (query) highlightInDoc(query);
}

// ---------- CSV 解析與渲染 ----------
function parseCsv(text) {
  const rows = [];
  let i = 0;
  while (i < text.length) {
    const row = [];
    while (i < text.length) {
      let val = '';
      if (text[i] === '"') {
        i++;
        while (i < text.length) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { val += '"'; i += 2; }
            else { i++; break; }
          } else { val += text[i]; i++; }
        }
      } else {
        const start = i;
        while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') i++;
        val = text.slice(start, i);
      }
      row.push(val);
      if (i < text.length && text[i] === ',') { i++; continue; }
      if (i < text.length && text[i] === '\r') i++;
      if (i < text.length && text[i] === '\n') i++;
      break;
    }
    if (row.length > 0 && !(row.length === 1 && row[0] === '')) rows.push(row);
  }
  return rows;
}

const CSV_PAGE_SIZE = 100;

function renderCsv(data, rel, mtime, rootId) {
  const rows = parseCsv(data.content);
  if (rows.length === 0) {
    el.doc.innerHTML = '<div class="empty-state"><p>CSV 檔案是空的</p></div>';
    el.toc.innerHTML = '';
    tocLinks = [];
    return;
  }

  const headers = rows[0];
  const allBody = rows.slice(1);
  const metaStr = '最後修改：' + new Date(mtime).toLocaleString('zh-TW');

  let html = '<div class="doc-meta"><span class="doc-meta-info">' + escapeHtml(rel) + ' · ' + metaStr +
    ' · ' + allBody.length + ' 筆</span>' +
    '<button class="open-btn" title="用系統預設編輯器開啟原始檔">' + ICON_EDIT + '<span>用編輯器開啟</span></button></div>';

  html += '<div class="csv-toolbar"><input type="text" class="csv-filter" placeholder="篩選…" autocomplete="off" />' +
    '<span class="csv-count"></span></div>';

  html += '<div class="csv-pager"></div>';

  html += '<div class="csv-wrap"><table class="csv-table"><thead><tr>';
  html += '<th class="csv-rownum">#</th>';
  for (const h of headers) html += '<th>' + escapeHtml(h) + '</th>';
  html += '</tr></thead><tbody></tbody></table></div>';

  html += '<div class="csv-pager csv-pager-bottom"></div>';

  el.doc.innerHTML = html;

  const openBtn = el.doc.querySelector('.open-btn');
  if (openBtn) openBtn.addEventListener('click', () => openInEditor(rootId, rel, openBtn));

  const filterInput = el.doc.querySelector('.csv-filter');
  const countSpan = el.doc.querySelector('.csv-count');
  const tbody = el.doc.querySelector('.csv-table tbody');
  const pagers = el.doc.querySelectorAll('.csv-pager');

  let filtered = allBody;
  let page = 0;

  function renderPage() {
    const totalPages = Math.max(1, Math.ceil(filtered.length / CSV_PAGE_SIZE));
    if (page >= totalPages) page = totalPages - 1;
    const start = page * CSV_PAGE_SIZE;
    const slice = filtered.slice(start, start + CSV_PAGE_SIZE);

    let rowsHtml = '';
    for (let r = 0; r < slice.length; r++) {
      rowsHtml += '<tr>';
      rowsHtml += '<td class="csv-rownum">' + (start + r + 1) + '</td>';
      for (let c = 0; c < headers.length; c++) {
        rowsHtml += '<td>' + escapeHtml(slice[r][c] || '') + '</td>';
      }
      rowsHtml += '</tr>';
    }
    tbody.innerHTML = rowsHtml;

    const pagerHtml = totalPages > 1
      ? '<button class="csv-page-btn csv-prev"' + (page === 0 ? ' disabled' : '') + '>&larr; 上一頁</button>' +
        '<span class="csv-page-info">' + (page + 1) + ' / ' + totalPages + '</span>' +
        '<button class="csv-page-btn csv-next"' + (page >= totalPages - 1 ? ' disabled' : '') + '>下一頁 &rarr;</button>'
      : '';
    pagers.forEach((p) => {
      p.innerHTML = pagerHtml;
      const prev = p.querySelector('.csv-prev');
      const next = p.querySelector('.csv-next');
      if (prev) prev.addEventListener('click', () => { page--; renderPage(); el.content.scrollTop = 0; });
      if (next) next.addEventListener('click', () => { page++; renderPage(); el.content.scrollTop = 0; });
    });
  }

  function updateCount() {
    if (filtered.length === allBody.length) {
      countSpan.textContent = allBody.length + ' 筆';
    } else {
      countSpan.textContent = filtered.length + ' / ' + allBody.length + ' 筆';
    }
  }

  filterInput.addEventListener('input', () => {
    const q = filterInput.value.trim().toLowerCase();
    if (!q) {
      filtered = allBody;
    } else {
      filtered = allBody.filter((row) => row.some((cell) => (cell || '').toLowerCase().includes(q)));
    }
    page = 0;
    updateCount();
    renderPage();
  });

  updateCount();
  renderPage();

  el.toc.innerHTML = '<div style="padding:0 16px;font-size:12px;color:var(--text-soft)">（CSV 表格）</div>';
  tocLinks = [];
}

// ---------- 檔案提及 → 內文連結 ----------
// 依「路徑字串」在檔案索引裡找對應檔案。裸檔名（無資料夾前綴）容易在多個專案撞名，
// 故只在有路徑前綴、且能唯一鎖定（或能靠目前開啟的 root 消歧義）時才回傳，避免點錯檔。
function resolveMention(pathText, preferRoot) {
  const norm = pathText.replace(/\\/g, '/');
  const matches = fileIndex.filter((f) => {
    const rel = f.rel.replace(/\\/g, '/');
    return rel === norm || rel.endsWith('/' + norm);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const preferred = matches.filter((m) => m.root === preferRoot);
    if (preferred.length === 1) return preferred[0];
  }
  return null;
}

// 把 a/b/../c.md 這種相對路徑壓平成 a/c.md
function normalizeRelPath(baseDir, relPath) {
  const combined = baseDir ? baseDir + '/' + relPath : relPath;
  const out = [];
  for (const part of combined.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

// markdown 裡的圖片是相對路徑（像 images/xxx.png），瀏覽器不會自己知道要去哪拿，
// 這裡把它改寫成閱讀器的圖片路由。網路圖片（http開頭）與 data: 不動。
function wireImages(container, rootId, rel) {
  const currentDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  container.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src || /^(https?:|data:|\/api\/)/i.test(src)) return;
    const target = normalizeRelPath(currentDir, src.split(/[?#]/)[0]);
    img.src = '/api/asset?root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(target);
    img.loading = 'lazy';
  });
}

function makeMentionLink(match, label) {
  const a = document.createElement('a');
  a.href = '#';
  a.className = 'file-mention-link';
  a.textContent = label;
  a.title = '開啟 ' + match.rel;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openFile(match.root, match.rel, null);
  });
  return a;
}

// 已經是 markdown 連結語法（[文字](路徑.md)）的，改成站內切換而非瀏覽器導頁
function rewireMarkdownLinks(currentRootId, currentRel) {
  const currentDir = currentRel.includes('/') ? currentRel.slice(0, currentRel.lastIndexOf('/')) : '';
  el.doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href || /^([a-z][\w+.-]*:)?\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:')) return;
    if (!/\.(md|markdown|mdown)(#.*)?$/i.test(href)) return;
    const pathPart = href.split('#')[0];
    const resolvedRel = normalizeRelPath(currentDir, decodeURIComponent(pathPart));
    let match = fileIndex.find((f) => f.root === currentRootId && f.rel === resolvedRel);
    if (!match) match = resolveMention(resolvedRel, currentRootId);
    if (!match) return;
    a.removeAttribute('href');
    a.classList.add('file-mention-link');
    a.style.cursor = 'pointer';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openFile(match.root, match.rel, null);
    });
  });
}

// 內文/行內代碼中純文字提到的路徑（例如 `agent-os/10-dispatch.md`、budget-app/CLAUDE.md）轉成連結
const MENTION_RE = /([\w.\-一-鿿]+(?:\/[\w.\-一-鿿]+)+\.(?:md|markdown|mdown))/g;

function linkifyMentions(currentRootId) {
  const walker = document.createTreeWalker(el.doc, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p || p.closest('a, pre, script, style')) return NodeFilter.FILTER_REJECT;
      MENTION_RE.lastIndex = 0;
      return MENTION_RE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);

  for (const node of targets) {
    const text = node.nodeValue;
    MENTION_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = MENTION_RE.exec(text))) {
      const match = resolveMention(m[1], currentRootId);
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(match ? makeMentionLink(match, m[1]) : document.createTextNode(m[1]));
      last = m.index + m[1].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function addHeadingIds() {
  const heads = el.doc.querySelectorAll('h1, h2, h3, h4');
  const used = {};
  heads.forEach((h) => {
    let base = (h.textContent || 'section').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '');
    if (!base) base = 'section';
    let id = base, n = 1;
    while (used[id]) { id = base + '-' + n++; }
    used[id] = true;
    h.id = id;
  });
}

// 在內文中高亮關鍵字，並捲到第一個
function highlightInDoc(query) {
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(el.doc, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.toLowerCase().includes(q)) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  let first = null;
  for (const node of targets) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let last = 0, idx = lower.indexOf(q);
    while (idx !== -1) {
      frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      if (!first) first = mark;
      last = idx + q.length;
      idx = lower.indexOf(q, last);
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  if (first) setTimeout(() => first.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
}

// 用系統預設編輯器開啟原始檔
async function openInEditor(root, rel, btn) {
  const label = btn && btn.querySelector('span');
  try {
    const res = await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, rel }),
    });
    const data = await res.json();
    if (label) {
      const orig = label.textContent;
      label.textContent = data.ok ? '已開啟' : '開啟失敗';
      setTimeout(() => { label.textContent = orig; }, 1500);
    }
  } catch {
    if (label) { label.textContent = '開啟失敗'; setTimeout(() => { label.textContent = '用編輯器開啟'; }, 1500); }
  }
}

// ---------- 閱讀模式直接勾待辦 ----------
//
// marked 會把 `- [ ] xxx` 渲染成 disabled 的方框。這裡把它打開讓人可以點，
// 點了就改原始檔案裡對應的那個 `[ ]` / `[x]`，不用進編輯模式。只在可編輯 root 開放。

// 把 ``` 圍起來的程式碼區塊換成等長的空白，避免程式碼範例裡的 `- [ ]` 被誤算進去
function maskCodeBlocks(text) {
  return text.replace(/```[\s\S]*?(```|$)/g, (m) => m.replace(/[^\n]/g, ' '));
}

// 要跟 marked 算出一樣的數量，所以引言（>）開頭、數字清單、巢狀縮排的待辦都要算進來
const TASK_MARKER_RE = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\][ \t]*)(.*)$/gm;

// 把 markdown 語法拿掉，只留文字，用來比對「我要改的這行」是不是「你點的那一項」
function plainText(s) {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [文字](網址) → 文字
    .replace(/[*_`~#]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

// 找出第 n 個（0-based）待辦標記，回傳改好的完整內容。
// expectedText 是畫面上那一項的文字：對不起來就回 null，寧可不改也不要改錯行。
function toggleTaskInSource(source, index, checked, expectedText) {
  const masked = maskCodeBlocks(source);
  let i = 0;
  let out = null;
  masked.replace(TASK_MARKER_RE, (match, before, mark, after, label, offset) => {
    if (i === index) {
      if (expectedText != null) {
        const a = plainText(label);
        const b = plainText(expectedText);
        const n = Math.min(6, a.length, b.length);
        if (n > 0 && a.slice(0, n) !== b.slice(0, n)) { i++; return match; } // 對不上，放棄
      }
      const start = offset + before.length;
      out = source.slice(0, start) + (checked ? 'x' : ' ') + source.slice(start + 1);
    }
    i++;
    return match;
  });
  return out;
}

function wireTaskCheckboxes() {
  const boxes = el.doc.querySelectorAll('li input[type="checkbox"]');
  boxes.forEach((box, index) => {
    box.disabled = false;
    box.classList.add('task-toggle');
    box.title = '點一下就直接存進檔案';
    box.addEventListener('change', async () => {
      if (!currentDoc) return;
      const label = (box.closest('li') || {}).textContent || '';
      const updated = toggleTaskInSource(currentDoc.content, index, box.checked, label);
      if (updated === null) {
        box.checked = !box.checked;
        return flashDocMsg('找不到對應的待辦項目，請用編輯模式修改');
      }
      box.disabled = true;
      const ok = await saveContent(updated, { silentReload: true });
      box.disabled = false;
      if (!ok) box.checked = !box.checked; // 存檔失敗就把畫面上的勾還原
      else flashDocMsg(box.checked ? '已勾選並存檔' : '已取消勾選並存檔');
    });
  });
}

let docMsgTimer = null;
function flashDocMsg(text) {
  let bar = document.getElementById('doc-toast');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'doc-toast';
    document.body.appendChild(bar);
  }
  bar.textContent = text;
  bar.classList.add('show');
  clearTimeout(docMsgTimer);
  docMsgTimer = setTimeout(() => bar.classList.remove('show'), 1800);
}

// ---------- 存檔（編輯模式與打勾共用）----------
//
// 帶著開檔時的 mtime 一起送出，後端會比對；對不上代表檔案被 Claude 或別的程式改過，
// 這時寧可擋下來讓人重看一次，也不要默默蓋掉別人的修改。
async function saveContent(content) {
  if (!currentDoc) return false;
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: currentDoc.root,
        rel: currentDoc.rel,
        content,
        baseMtime: currentDoc.mtime,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      flashDocMsg(data.error || '存檔失敗');
      return false;
    }
    currentDoc.content = content;
    currentDoc.mtime = data.mtime;
    suppressReloadUntil = Date.now() + 1500; // 自己存的檔，別讓 SSE 又把畫面刷掉
    return true;
  } catch {
    flashDocMsg('存檔失敗：連不上閱讀器服務');
    return false;
  }
}

// ---------- 編輯模式 ----------
//
// 左邊打字、右邊即時預覽。⌘S 存檔、Esc 離開。存檔後自動回閱讀模式。

function enterEdit() {
  if (!currentDoc || currentDoc.type === 'csv' || !isEditableRoot(currentDoc.root)) return;
  isEditing = true;
  isDirty = false;
  el.editorInput.value = currentDoc.content;
  el.editorPath.value = currentDoc.rel;
  el.editor.hidden = false;
  document.getElementById('content').hidden = true;
  document.body.classList.add('editing'); // 收起右側大綱，空間讓給編輯與預覽
  tocLinks = [];
  updateEditStatus();
  renderPreview();
  el.editorInput.focus();
  el.editorInput.setSelectionRange(0, 0);
}

function exitEdit(skipConfirm) {
  if (!isEditing) return;
  if (isDirty && !skipConfirm && !confirm('有還沒儲存的修改，確定要放棄嗎？')) return;
  isEditing = false;
  isDirty = false;
  el.editor.hidden = true;
  document.getElementById('content').hidden = false;
  document.body.classList.remove('editing'); // 大綱放回來
}

function updateEditStatus() {
  el.editorStatus.textContent = isDirty ? '● 未儲存' : '已是最新';
  el.editorStatus.classList.toggle('dirty', isDirty);
}

// 內容或檔名任一被動過，就算有未存的修改
function recomputeDirty() {
  if (!currentDoc) return;
  isDirty = el.editorInput.value !== currentDoc.content
    || el.editorPath.value.trim() !== currentDoc.rel;
  updateEditStatus();
}

el.editorPath.addEventListener('input', recomputeDirty);
// 在檔名欄按 Enter 直接存檔，不會在檔名裡打出換行
el.editorPath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) return;
  if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
});

let previewTimer = null;
function renderPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const dirty = marked.parse(el.editorInput.value);
    el.editorPreview.innerHTML = DOMPurify.sanitize(dirty, { ADD_ATTR: ['id'] });
    el.editorPreview.querySelectorAll('pre code').forEach((block) => {
      try { hljs.highlightElement(block); } catch {}
    });
    if (currentDoc) wireImages(el.editorPreview, currentDoc.root, currentDoc.rel);
  }, 120);
}

el.editorInput.addEventListener('input', () => {
  recomputeDirty();
  renderPreview();
});

// 打字時把預覽捲到差不多的位置，長文件才不會要一直手動捲
el.editorInput.addEventListener('scroll', () => {
  const ta = el.editorInput;
  const max = ta.scrollHeight - ta.clientHeight;
  if (max <= 0) return;
  const ratio = ta.scrollTop / max;
  const pv = el.editorPreview;
  pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight);
});

// 貼上或拖曳圖片：上傳到 images/ 子資料夾，插入 ![](images/xxx.png)
function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  textarea.value = value.slice(0, start) + text + value.slice(end);
  const pos = start + text.length;
  textarea.setSelectionRange(pos, pos);
  textarea.dispatchEvent(new Event('input'));
  textarea.focus();
}

async function uploadPastedImage(file) {
  if (!currentDoc || !isEditableRoot(currentDoc.root)) return;
  el.editorStatus.textContent = '上傳圖片中…';
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const res = await fetch('/api/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: currentDoc.root, rel: currentDoc.rel, mime: file.type, data: dataUrl }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '圖片上傳失敗'); return; }
    insertAtCursor(el.editorInput, '![](' + data.rel + ')');
  } catch {
    alert('圖片上傳失敗');
  } finally {
    updateEditStatus();
  }
}

el.editorInput.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
  if (!imageItem) return;
  e.preventDefault();
  uploadPastedImage(imageItem.getAsFile());
});

el.editorInput.addEventListener('dragover', (e) => {
  const items = Array.from(e.dataTransfer?.items || []);
  if (items.some((it) => it.kind === 'file' && it.type.startsWith('image/'))) e.preventDefault();
});

el.editorInput.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  files.forEach((f) => uploadPastedImage(f));
});

// Enter 自動延續清單／待辦、Tab 縮排
el.editorInput.addEventListener('keydown', (e) => {
  const ta = el.editorInput;

  if (e.key === 'Tab') {
    e.preventDefault();
    const start = ta.selectionStart;
    ta.setRangeText('  ', start, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
    return;
  }

  if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) return;

  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
    const start = ta.selectionStart;
    if (start !== ta.selectionEnd) return;
    const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
    const line = ta.value.slice(lineStart, start);

    // 待辦：`- [x] 內容` → 下一行給空的 `- [ ] `
    const task = line.match(/^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\][ \t]+(.*)$/);
    if (task) {
      e.preventDefault();
      const prefix = task[1] + '[ ] ';
      // 空的待辦再按一次 Enter 就結束清單
      const insert = task[2].trim() === '' ? '\n' : '\n' + prefix;
      if (task[2].trim() === '') ta.setRangeText('', lineStart, start, 'end');
      ta.setRangeText(insert, ta.selectionStart, ta.selectionStart, 'end');
      ta.dispatchEvent(new Event('input'));
      return;
    }

    // 一般清單：`- 內容` / `1. 內容`
    const bullet = line.match(/^([ \t]*)([-*+]|(\d+)[.)])[ \t]+(.*)$/);
    if (bullet) {
      e.preventDefault();
      if (bullet[4].trim() === '') {
        ta.setRangeText('\n', lineStart, start, 'end');
      } else {
        const marker = bullet[3] ? (parseInt(bullet[3], 10) + 1) + '. ' : bullet[2] + ' ';
        ta.setRangeText('\n' + bullet[1] + marker, start, start, 'end');
      }
      ta.dispatchEvent(new Event('input'));
    }
  }
});

async function saveEdit() {
  if (!isEditing || !currentDoc) return;
  const content = el.editorInput.value;
  const newRel = el.editorPath.value.trim();
  const renaming = newRel && newRel !== currentDoc.rel;

  el.editorSave.disabled = true;
  el.editorStatus.textContent = '儲存中…';

  // 先存內容（用原本的路徑），成功了再改名，這樣改名失敗也不會丟掉你打的字
  const ok = await saveContent(content);
  if (!ok) { el.editorSave.disabled = false; updateEditStatus(); return; }

  if (renaming) {
    const renamed = await renameCurrent(newRel);
    el.editorSave.disabled = false;
    if (!renamed) {
      // 內容已存好，只是檔名沒改成。把欄位轉回原檔名，讓畫面跟實際狀況一致
      el.editorPath.value = currentDoc.rel;
      recomputeDirty();
      return;
    }
  }
  el.editorSave.disabled = false;

  isDirty = false;
  exitEdit(true);
  renderMarkdown({ content, mtime: currentDoc.mtime, type: currentDoc.type }, currentDoc.rel, currentDoc.root);
  flashDocMsg(renaming ? '已儲存，檔名改為 ' + currentDoc.rel.split('/').pop() : '已儲存');
}

el.editorSave.addEventListener('click', saveEdit);
el.editorCancel.addEventListener('click', () => exitEdit(false));

// 全域快捷鍵：⌘S 存檔、Esc 離開編輯、⌘E 進編輯
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') {
    if (isEditing) { e.preventDefault(); saveEdit(); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'e') {
    if (!isEditing && currentDoc && currentDoc.type !== 'csv' && isEditableRoot(currentDoc.root)) { e.preventDefault(); enterEdit(); }
    return;
  }
  if (e.key === 'Escape' && isEditing && el.newFileModal.hidden) {
    exitEdit(false);
  }
});

// 關掉分頁前，未存的東西提醒一下
window.addEventListener('beforeunload', (e) => {
  if (isEditing && isDirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- 改檔名 ----------
//
// 沒有獨立按鈕：編輯模式上方那格檔名就是輸入框，改完跟著存檔一起生效。

async function renameCurrent(newRel) {
  const { root, rel } = currentDoc;
  try {
    const res = await fetch('/api/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, rel, newRel }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      flashDocMsg(data.error || '改名失敗');
      return false;
    }
    // 這個檔案如果被釘選，釘選也要跟著換路徑，不然會指到不存在的檔
    const oldKey = pinKey('file', root, rel);
    if (pinSet.has(oldKey)) {
      state.pins = state.pins.map((p) => (pinKey(p.type, p.root, p.rel) === oldKey
        ? { ...p, rel: data.rel, name: data.rel.split('/').pop() }
        : p));
      rebuildPinSet();
      saveState();
    }
    currentDoc.rel = data.rel;
    el.editorPath.value = data.rel;
    setHash(root, data.rel);
    suppressReloadUntil = Date.now() + 1500;
    await loadTree();
    return true;
  } catch {
    flashDocMsg('改名失敗：連不上閱讀器服務');
    return false;
  }
}

// ---------- 新增檔案 ----------
function openNewFileModal() {
  el.newFileError.hidden = true;
  el.newFileModal.hidden = false;
  // 預設帶目前檔案所在的資料夾（限可編輯 root），接著打檔名就好
  const dir = (currentDoc && isEditableRoot(currentDoc.root)) ? currentDoc.rel.split('/').slice(0, -1).join('/') : '';
  el.newFilePath.value = dir ? dir + '/' : '';
  el.newFilePath.focus();
  el.newFilePath.setSelectionRange(el.newFilePath.value.length, el.newFilePath.value.length);
}

function closeNewFileModal() {
  el.newFileModal.hidden = true;
}

function showModalError(msg) {
  el.newFileError.textContent = msg;
  el.newFileError.hidden = false;
}

// 新檔預設建在目前檔案所在的可編輯 root；若目前開的是唯讀（memory）root，改用第一個可編輯 root
function pickNewFileRoot() {
  if (currentDoc && isEditableRoot(currentDoc.root)) return currentDoc.root;
  const firstEditable = treeData && treeData.roots.find((r) => r.editable);
  return firstEditable ? firstEditable.id : null;
}

async function createFile() {
  const rel = el.newFilePath.value.trim();
  if (!rel) return;
  const rootId = pickNewFileRoot();
  if (!rootId) return showModalError('找不到可以建立檔案的目錄');
  try {
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: rootId, rel }),
    });
    const data = await res.json();
    if (!res.ok || data.error) return showModalError(data.error || '建立失敗');
    closeNewFileModal();
    await loadTree();
    await openFile(rootId, data.rel, null);
    enterEdit();
  } catch {
    showModalError('建立失敗：連不上閱讀器服務');
  }
}

el.newFileBtn.addEventListener('click', openNewFileModal);
el.newFileOk.addEventListener('click', createFile);
el.newFileCancel.addEventListener('click', closeNewFileModal);
el.newFileModal.addEventListener('click', (e) => { if (e.target === el.newFileModal) closeNewFileModal(); });
el.newFilePath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) return;
  if (e.key === 'Enter') { e.preventDefault(); createFile(); }
  if (e.key === 'Escape') { e.preventDefault(); closeNewFileModal(); }
});

// ---------- TOC ----------
let tocLinks = [];
function buildToc() {
  el.toc.innerHTML = '';
  tocLinks = [];
  const heads = el.doc.querySelectorAll('h1, h2, h3, h4');
  if (heads.length === 0) {
    el.toc.innerHTML = '<div style="padding:0 16px;font-size:12px;color:var(--text-soft)">（無標題）</div>';
    return;
  }
  heads.forEach((h) => {
    const lvl = parseInt(h.tagName[1], 10);
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'lvl-' + lvl;
    a.textContent = h.textContent;
    a.addEventListener('click', (e) => { e.preventDefault(); h.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    el.toc.appendChild(a);
    tocLinks.push({ a, h });
  });
}

el.content.addEventListener('scroll', () => {
  if (!tocLinks.length) return;
  let current = tocLinks[0];
  const top = el.content.scrollTop + 80;
  for (const item of tocLinks) {
    if (item.h.offsetTop <= top) current = item; else break;
  }
  tocLinks.forEach((item) => item.a.classList.toggle('active', item === current));
});

// ---------- 排序切換 ----------
el.sortSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const mode = btn.dataset.sort;
  if (mode === state.sort) return;
  state.sort = mode;
  saveState();
  render();
});

// ---------- 搜尋 ----------
let searchTimer = null;
let lastQuery = '';
el.search.addEventListener('input', () => {
  const q = el.search.value.trim();
  lastQuery = q;
  el.searchClear.hidden = q.length === 0;
  clearTimeout(searchTimer);
  if (q.length < 2) { showTree(); return; }
  searchTimer = setTimeout(() => runSearch(q), 220);
});
el.searchClear.addEventListener('click', () => {
  el.search.value = '';
  el.searchClear.hidden = true;
  lastQuery = '';
  showTree();
  el.search.focus();
});

function showTree() {
  el.tree.hidden = false;
  el.searchResults.hidden = true;
}

async function runSearch(q) {
  const res = await fetch('/api/search?q=' + encodeURIComponent(q));
  const data = await res.json();
  el.tree.hidden = true;
  el.searchResults.hidden = false;
  if (!data.results.length) {
    el.searchResults.innerHTML = '<div class="sr-empty">找不到符合「' + escapeHtml(q) + '」的結果</div>';
    return;
  }
  el.searchResults.innerHTML = '';
  for (const r of data.results) {
    const item = document.createElement('div');
    item.className = 'sr-item';
    const snippetHtml = r.snippet ? '<div class="sr-snippet">' + highlight(r.snippet, q) + '</div>' : '';
    item.innerHTML =
      '<div class="sr-name">' + highlight(r.name, q) + '</div>' +
      '<div class="sr-path">' + escapeHtml(r.rel) + '</div>' + snippetHtml;
    item.addEventListener('click', () => openFile(r.root, r.rel, null, q));
    el.searchResults.appendChild(item);
  }
}

function highlight(text, q) {
  const safe = escapeHtml(text);
  const safeQ = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp('(' + safeQ + ')', 'gi'), '<mark>$1</mark>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 檔案變動自動更新（SSE）----------
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = async (e) => {
    try {
      const change = JSON.parse(e.data);
      const isCurrent = currentDoc && change.root === currentDoc.root && change.rel === currentDoc.rel;
      // 編輯中不重載當前檔案，否則會把還沒存的內容洗掉；
      // 剛自己存完的那一下也跳過，不然畫面會多閃一次。
      const skip = isEditing || Date.now() < suppressReloadUntil;
      if (isCurrent && !skip) {
        const scrollTop = el.content.scrollTop;
        await openFile(currentDoc.root, currentDoc.rel, activeFileEl);
        requestAnimationFrame(() => { el.content.scrollTop = scrollTop; });
      } else if (isCurrent && isEditing) {
        flashDocMsg('注意：這個檔案剛剛被其他程式改過，你存檔時會被擋下來');
      }
      // 重新載入檔案樹（新增/刪除/重新命名檔案）
      await loadTree();
    } catch {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

// ---------- 啟動 ----------
(async function init() {
  await loadState();
  await loadTree();
  if (location.hash.length > 1) {
    const raw = decodeURIComponent(location.hash.slice(1));
    const sep = raw.indexOf('::');
    if (sep > -1) openFile(raw.slice(0, sep), raw.slice(sep + 2), null);
  }
  connectSSE();
})();
