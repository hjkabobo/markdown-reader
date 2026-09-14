'use strict';

// md-reader — 本機 markdown 閱讀器
// 純 Node 內建模組，零依賴。掃描指定 repo 底下所有 .md，提供樹狀清單、檔案內容與全文搜尋。

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const url = require('url');
const os = require('os');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 2004; // 2004 = Markdown 誕生年
const HOME = os.homedir();

// 各機器自己的掃描範圍設定（要掃哪些 repo、要不要掃 Claude memory）。
// reader.config.js 被 .gitignore 排除、不同步；缺檔時退回範本 reader.config.example.js。
let localConfig;
try {
  localConfig = require('./reader.config.js');
} catch {
  localConfig = require('./reader.config.example.js');
}

// 只接受 Host 是本機的請求，擋掉 DNS rebinding 與惡意網頁對 localhost 的招數
const ALLOWED_HOSTS = new Set([
  'localhost:' + PORT, '127.0.0.1:' + PORT, '[::1]:' + PORT,
  'localhost', '127.0.0.1',
]);
function hostAllowed(req) {
  return ALLOWED_HOSTS.has((req.headers.host || '').toLowerCase());
}

// 寫入類請求（POST）再多一道：Origin 必須是閱讀器自己，擋掉別的網頁偷偷對 localhost 送出改檔請求
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 同源 fetch 不一定帶 Origin
  try {
    return ALLOWED_HOSTS.has(new URL(origin).host.toLowerCase());
  } catch {
    return false;
  }
}

function rootIdFromPath(prefix, value) {
  return (prefix + '-' + value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Claude memory 目錄名（如 -Users-you-Documents-my-repo）在畫面上要顯示成什麼、
// 以及顯示順序，都由本機設定檔 reader.config.js 提供；沒設定就用原始目錄名。
const MEMORY_LABELS = new Map(Object.entries(localConfig.memoryLabels || {}));

const MEMORY_LABEL_ORDER = localConfig.memoryLabelOrder || [];

function displayProjectName(name) {
  return MEMORY_LABELS.get(name) || (name.startsWith('-') ? name.slice(1).replace(/-/g, '/') : name);
}

function discoverMemoryRoots(baseDir, labelPrefix, idPrefix) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((ent) => ent.isDirectory())
    .map((ent) => {
      const memoryDir = path.join(baseDir, ent.name, 'memory');
      if (!fs.existsSync(memoryDir)) return null;
      return {
        id: rootIdFromPath(idPrefix, ent.name),
        label: labelPrefix + ' (' + displayProjectName(ent.name) + ')',
        dir: memoryDir,
        wrapDirName: 'memory',
      };
    })
    .filter(Boolean);
}

function sortMemoryRoots(roots) {
  return roots.sort((a, b) => {
    const aName = a.label.match(/\((.*)\)$/)?.[1] || a.label;
    const bName = b.label.match(/\((.*)\)$/)?.[1] || b.label;
    const aIndex = MEMORY_LABEL_ORDER.indexOf(aName);
    const bIndex = MEMORY_LABEL_ORDER.indexOf(bName);
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex)
      || a.label.localeCompare(b.label, 'zh-Hant');
  });
}

const CLAUDE_MEMORY_ROOTS = localConfig.scanClaudeMemory === false ? [] : sortMemoryRoots([
  ...discoverMemoryRoots(path.join(HOME, '.claude/projects'), 'Claude Memory', 'claude-memory'),
  ...discoverMemoryRoots(path.join(HOME, '.claude-client/projects'), 'Claude Memory', 'claude-client-memory'),
]);

// 允許掃描的根目錄（白名單）。只有這些目錄底下的 .md 會被讀到。
// 專案 repo 清單由本機設定檔 reader.config.js 提供（各機器一份、不同步），
// 換電腦或不同機器只要改設定檔、不必動 server.js。
const ROOTS = [
  ...localConfig.projectRoots,
  ...CLAUDE_MEMORY_ROOTS,
].filter((r) => fs.existsSync(r.dir));

// 可編輯的 root（僅三個 repo；memory／Codex 目錄唯讀，避免閱讀器誤改索引造成格式跑掉）
const EDITABLE_ROOT_IDS = new Set(ROOTS.filter((r) => r.editable).map((r) => r.id));

// 掃描時略過的資料夾
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', 'target', 'out']);

const PUBLIC_DIR = path.join(__dirname, 'public');

// --- 工具函式 -------------------------------------------------------------

function isMarkdown(name) {
  return /\.(md|markdown|mdown)$/i.test(name);
}

function isCsv(name) {
  return /\.csv$/i.test(name);
}

function isSupported(name) {
  return isMarkdown(name) || isCsv(name);
}

// markdown 裡插的圖片（只讀不寫，也不會出現在左側清單）
function isImage(name) {
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);
}

// 遞迴建立某個 root 的樹。回傳 { dirs:[...], files:[...] } 巢狀結構。
// 只保留含有 markdown 的資料夾，避免清單塞一堆空目錄。
async function buildTree(absDir, rootDir) {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return { dirs: [], files: [] };
  }

  const dirs = [];
  const files = [];

  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.claude') continue;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const childAbs = path.join(absDir, ent.name);
      const child = await buildTree(childAbs, rootDir);
      if (child.dirs.length || child.files.length) {
        dirs.push({
          name: ent.name,
          rel: path.relative(rootDir, childAbs),
          dirs: child.dirs,
          files: child.files,
        });
      }
    } else if (ent.isFile() && isSupported(ent.name)) {
      const abs = path.join(absDir, ent.name);
      let mtime = 0;
      try {
        mtime = (await fsp.stat(abs)).mtimeMs;
      } catch {}
      files.push({
        name: ent.name,
        rel: path.relative(rootDir, abs),
        mtime,
        type: isCsv(ent.name) ? 'csv' : 'md',
      });
    }
  }

  // 資料夾、檔案各自照名稱排序
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  return { dirs, files };
}

// 把使用者要求的 root + rel 還原成安全的絕對路徑。
// 防止 ../ 跳脫白名單目錄。回傳 null 代表非法。
// allow 決定放行哪些副檔名（預設只放行 markdown / CSV；圖片路由另外傳 isImage）
function resolveSafe(rootId, rel, allow) {
  const root = ROOTS.find((r) => r.id === rootId);
  if (!root) return null;
  if (typeof rel !== 'string') return null;
  // 正規化後必須仍在 root 底下，且是支援的檔案類型（markdown 或 csv）
  const abs = path.resolve(root.dir, rel);
  const rootWithSep = root.dir.endsWith(path.sep) ? root.dir : root.dir + path.sep;
  if (abs !== root.dir && !abs.startsWith(rootWithSep)) return null;
  if (!(allow || isSupported)(abs)) return null;
  return abs;
}

// 收集某 root 底下所有 markdown 的絕對路徑（給搜尋用）
async function collectFiles(absDir, out) {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.claude') continue;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      await collectFiles(path.join(absDir, ent.name), out);
    } else if (ent.isFile() && isSupported(ent.name)) {
      out.push(path.join(absDir, ent.name));
    }
  }
}

// --- 路由 -----------------------------------------------------------------

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleTree(res) {
  const roots = [];
  for (const r of ROOTS) {
    const tree = await buildTree(r.dir, r.dir);
    if (r.wrapDirName && (tree.dirs.length || tree.files.length)) {
      roots.push({
        id: r.id,
        label: r.label,
        editable: EDITABLE_ROOT_IDS.has(r.id),
        dirs: [{ name: r.wrapDirName, rel: '', dirs: tree.dirs, files: tree.files }],
        files: [],
      });
    } else {
      roots.push({ id: r.id, label: r.label, editable: EDITABLE_ROOT_IDS.has(r.id), dirs: tree.dirs, files: tree.files });
    }
  }
  sendJson(res, 200, { roots });
}

async function handleFile(res, query) {
  const abs = resolveSafe(query.root, query.path);
  if (!abs) return sendJson(res, 400, { error: '路徑不合法或不是支援的檔案類型' });
  try {
    const content = await fsp.readFile(abs, 'utf8');
    const stat = await fsp.stat(abs);
    const fileType = isCsv(abs) ? 'csv' : 'md';
    sendJson(res, 200, { content, mtime: stat.mtimeMs, name: path.basename(abs), type: fileType });
  } catch {
    sendJson(res, 404, { error: '找不到檔案' });
  }
}

// markdown 內嵌的圖片。走同一套路徑白名單，只給讀、只給圖片副檔名。
async function handleAsset(res, query) {
  const abs = resolveSafe(query.root, query.path, isImage);
  if (!abs) return sendJson(res, 400, { error: '路徑不合法或不是圖片' });
  try {
    const data = await fsp.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: '找不到圖片' });
  }
}

async function handleSearch(res, query) {
  const q = (query.q || '').trim();
  if (q.length < 2) return sendJson(res, 200, { results: [] });
  const needle = q.toLowerCase();
  const results = [];

  for (const r of ROOTS) {
    const files = [];
    await collectFiles(r.dir, files);
    for (const abs of files) {
      let text;
      try {
        text = await fsp.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      const name = path.basename(abs);
      const nameHit = name.toLowerCase().includes(needle);
      const idx = lower.indexOf(needle);
      if (idx === -1 && !nameHit) continue;

      // 取一段含關鍵字的內文當預覽
      let snippet = '';
      if (idx !== -1) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(text.length, idx + needle.length + 60);
        snippet = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + '…';
      }
      results.push({
        root: r.id,
        rel: path.relative(r.dir, abs),
        name,
        nameHit,
        snippet,
      });
    }
  }
  // 檔名命中的排前面
  results.sort((a, b) => (b.nameHit ? 1 : 0) - (a.nameHit ? 1 : 0));
  sendJson(res, 200, { results: results.slice(0, 60) });
}

// --- 個人設定（釘選、排序）存成專案檔 -------------------------------------
const STATE_FILE = path.join(__dirname, '.reader-state.json');
const DEFAULT_STATE = { sort: 'name', pins: [] };

async function handleGetState(res) {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    sendJson(res, 200, JSON.parse(raw));
  } catch {
    sendJson(res, 200, DEFAULT_STATE);
  }
}

function readBody(req, maxSize = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxSize) { req.destroy(); reject(new Error('too large')); }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handlePostState(req, res) {
  try {
    const parsed = JSON.parse(await readBody(req));
    // 只接受認得的欄位，避免亂寫
    const clean = {
      sort: parsed.sort === 'mtime' ? 'mtime' : 'name',
      pins: Array.isArray(parsed.pins)
        ? parsed.pins.slice(0, 300).map((p) => ({
            type: p.type === 'dir' ? 'dir' : 'file',
            root: String(p.root || ''),
            rel: String(p.rel || ''),
            name: String(p.name || ''),
          }))
        : [],
    };
    await fsp.writeFile(STATE_FILE, JSON.stringify(clean, null, 2), 'utf8');
    sendJson(res, 200, { ok: true });
  } catch {
    sendJson(res, 400, { error: '設定格式不正確' });
  }
}

// --- 寫入（編輯 / 新增）---------------------------------------------------
//
// 四道防線：
// 1. resolveSafe 保證路徑在白名單 root 底下
// 2. 只允許寫「可編輯 root」（三個 repo；memory／Codex 目錄唯讀，避免閱讀器誤改索引格式）
// 3. 只允許寫 markdown（CSV 是資料檔，閱讀器不給改，避免弄壞來源資料）
// 4. 寫入前先備份舊檔到 .backups/，且比對 mtime 擋掉「改到別人剛存過的版本」

const BACKUP_DIR = path.join(__dirname, '.backups');
const BACKUPS_PER_FILE = 10;

// 存檔前把舊內容留一份，同一檔只留最近 BACKUPS_PER_FILE 份
async function backupBeforeWrite(abs, rootId, rel) {
  let old;
  try {
    old = await fsp.readFile(abs, 'utf8');
  } catch {
    return; // 新檔，沒有舊版可備份
  }
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const flat = (rootId + '__' + rel).replace(/[/\\]/g, '__');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.writeFile(path.join(BACKUP_DIR, flat + '.' + stamp + '.bak'), old, 'utf8');

  // 修剪：同一檔案的備份超過上限就刪最舊的
  try {
    const all = (await fsp.readdir(BACKUP_DIR))
      .filter((n) => n.startsWith(flat + '.'))
      .sort();
    for (const name of all.slice(0, Math.max(0, all.length - BACKUPS_PER_FILE))) {
      await fsp.unlink(path.join(BACKUP_DIR, name)).catch(() => {});
    }
  } catch {}
}

async function handleSave(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: '內容格式不正確' });
  }
  if (!EDITABLE_ROOT_IDS.has(parsed.root)) return sendJson(res, 403, { error: '此目錄唯讀，不開放編輯' });
  const abs = resolveSafe(parsed.root, parsed.rel);
  if (!abs) return sendJson(res, 400, { error: '路徑不合法' });
  if (!isMarkdown(abs)) return sendJson(res, 400, { error: 'CSV 檔案不開放編輯' });
  if (typeof parsed.content !== 'string') return sendJson(res, 400, { error: '缺少內容' });

  // 衝突偵測：前端帶著「開啟時看到的 mtime」回來，跟現在的檔案比對。
  // 對不上代表這份檔案在你編輯期間被別人（或 Claude）改過，不能盲目覆蓋。
  try {
    const stat = await fsp.stat(abs);
    if (parsed.baseMtime && Math.abs(stat.mtimeMs - parsed.baseMtime) > 1) {
      return sendJson(res, 409, {
        error: '這個檔案在你編輯期間被改過了。請先複製你的修改內容，重新整理後再貼上。',
      });
    }
  } catch {
    return sendJson(res, 404, { error: '找不到檔案' });
  }

  try {
    await backupBeforeWrite(abs, parsed.root, parsed.rel);
    await fsp.writeFile(abs, parsed.content, 'utf8');
    const stat = await fsp.stat(abs);
    sendJson(res, 200, { ok: true, mtime: stat.mtimeMs });
  } catch (err) {
    sendJson(res, 500, { error: '存檔失敗：' + (err && err.message) });
  }
}

async function handleCreate(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: '內容格式不正確' });
  }
  if (!EDITABLE_ROOT_IDS.has(parsed.root)) return sendJson(res, 403, { error: '此目錄唯讀，不開放新增' });
  let rel = String(parsed.rel || '').trim().replace(/^\/+/, '');
  if (!rel) return sendJson(res, 400, { error: '請輸入檔名' });
  if (!isMarkdown(rel)) rel += '.md';

  const abs = resolveSafe(parsed.root, rel);
  if (!abs) return sendJson(res, 400, { error: '路徑不合法' });
  if (fs.existsSync(abs)) return sendJson(res, 409, { error: '檔案已經存在' });

  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const title = path.basename(abs).replace(/\.(md|markdown|mdown)$/i, '');
    await fsp.writeFile(abs, '# ' + title + '\n\n', 'utf8');
    sendJson(res, 200, { ok: true, rel });
  } catch (err) {
    sendJson(res, 500, { error: '建立失敗：' + (err && err.message) });
  }
}

// 改檔名（也可以順便換資料夾，因為帶的是完整相對路徑）
async function handleRename(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: '內容格式不正確' });
  }
  if (!EDITABLE_ROOT_IDS.has(parsed.root)) return sendJson(res, 403, { error: '此目錄唯讀，不開放改名' });
  const from = resolveSafe(parsed.root, parsed.rel);
  let toRel = String(parsed.newRel || '').trim().replace(/^\/+/, '');
  if (!toRel) return sendJson(res, 400, { error: '請輸入新檔名' });
  if (!isMarkdown(toRel)) toRel += '.md';
  const to = resolveSafe(parsed.root, toRel);

  if (!from || !to) return sendJson(res, 400, { error: '路徑不合法' });
  if (!isMarkdown(from)) return sendJson(res, 400, { error: '只有 markdown 檔可以改名' });
  if (!fs.existsSync(from)) return sendJson(res, 404, { error: '找不到原始檔案' });
  if (from === to) return sendJson(res, 200, { ok: true, rel: toRel });
  if (fs.existsSync(to)) return sendJson(res, 409, { error: '已經有同名的檔案了' });

  try {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    sendJson(res, 200, { ok: true, rel: toRel });
  } catch (err) {
    sendJson(res, 500, { error: '改名失敗：' + (err && err.message) });
  }
}

// 貼上／拖曳圖片。存到目前編輯檔案同資料夾底下的 images/ 子資料夾，
// 回傳相對於該檔案的路徑，前端直接插入 ![](路徑) 就能跟 wireImages 的解析方式對上。
const UPLOAD_EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MAX_UPLOAD_BYTES = 15_000_000;

async function handleUploadImage(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req, 25_000_000));
  } catch (err) {
    return sendJson(res, 400, { error: err && err.message === 'too large' ? '圖片太大' : '內容格式不正確' });
  }
  if (!EDITABLE_ROOT_IDS.has(parsed.root)) return sendJson(res, 403, { error: '此目錄唯讀，不開放上傳' });

  const docAbs = resolveSafe(parsed.root, parsed.rel);
  if (!docAbs || !isMarkdown(docAbs)) return sendJson(res, 400, { error: '路徑不合法' });

  const ext = UPLOAD_EXT_BY_MIME[parsed.mime];
  if (!ext) return sendJson(res, 400, { error: '不支援的圖片格式' });

  const match = /^data:image\/[a-z]+;base64,([a-zA-Z0-9+/=]+)$/.exec(String(parsed.data || ''));
  if (!match) return sendJson(res, 400, { error: '圖片資料格式不正確' });
  const buf = Buffer.from(match[1], 'base64');
  if (buf.length > MAX_UPLOAD_BYTES) return sendJson(res, 400, { error: '圖片太大（上限 15MB）' });

  const docDir = path.dirname(docAbs);
  const imagesDir = path.join(docDir, 'images');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = 'pasted-' + stamp + '.' + ext;
  const abs = path.join(imagesDir, filename);

  try {
    await fsp.mkdir(imagesDir, { recursive: true });
    await fsp.writeFile(abs, buf);
    sendJson(res, 200, { ok: true, rel: 'images/' + filename });
  } catch (err) {
    sendJson(res, 500, { error: '圖片存檔失敗：' + (err && err.message) });
  }
}

// 用系統預設 app 開啟原始檔（只開白名單內的 markdown）
async function handleOpen(req, res) {
  try {
    const parsed = JSON.parse(await readBody(req));
    const abs = resolveSafe(parsed.root, parsed.rel);
    if (!abs || !fs.existsSync(abs)) return sendJson(res, 400, { error: '路徑不合法或檔案不存在' });
    // execFile 不經 shell，abs 當參數傳入，不會有指令注入
    execFile('open', [abs], () => {});
    sendJson(res, 200, { ok: true });
  } catch {
    sendJson(res, 400, { error: '無法開啟' });
  }
}

// 靜態檔案
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await fsp.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// --- 檔案變動監聽（SSE）-----------------------------------------------------
const sseClients = new Set();

function broadcastChange(rootId, rel) {
  const data = JSON.stringify({ root: rootId, rel });
  for (const client of sseClients) {
    client.write('data: ' + data + '\n\n');
  }
}

// 一次檔案異動要做什麼：
//   'ignore' 不關我們的事（跳過的目錄、隱藏檔、其他副檔名的檔案）
//   'file'   是清單裡的 md/csv，重載這個檔
//   'tree'   看起來是目錄異動（沒有副檔名），重載檔案樹
// IntelliJ 啟動時會對整個 repo 狂寫 .class/.jar/.iml 之類的東西，
// 以前那些都會轉成一次檔案樹重載，左側就一直刷新；現在直接 ignore。
function classifyChange(filename) {
  const parts = filename.split(path.sep);
  if (parts.some((p) => SKIP_DIRS.has(p) || (p.startsWith('.') && p !== '.claude'))) return 'ignore';
  if (isSupported(filename)) return 'file';
  return path.extname(filename) ? 'ignore' : 'tree';
}

let changeTimers = {};
let treeChangeTimer = null;
for (const root of ROOTS) {
  try {
    fs.watch(root.dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const kind = classifyChange(filename);
      if (kind === 'ignore') return;

      if (kind === 'tree') {
        // 目錄異動常常一次來一整串，收斂成一次刷新就好。
        clearTimeout(treeChangeTimer);
        treeChangeTimer = setTimeout(() => broadcastChange(root.id, ''), 1000);
        return;
      }

      const key = root.id + '|' + filename;
      clearTimeout(changeTimers[key]);
      changeTimers[key] = setTimeout(() => {
        delete changeTimers[key];
        broadcastChange(root.id, filename);
      }, 300);
    });
  } catch {}
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden host');
  }
  if (req.method === 'POST' && !originAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden origin');
  }
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  try {
    if (pathname === '/api/events') return handleSSE(req, res);
    if (pathname === '/api/tree') return await handleTree(res);
    if (pathname === '/api/file') return await handleFile(res, parsed.query);
    if (pathname === '/api/asset') return await handleAsset(res, parsed.query);
    if (pathname === '/api/search') return await handleSearch(res, parsed.query);
    if (pathname === '/api/state' && req.method === 'POST') return await handlePostState(req, res);
    if (pathname === '/api/state') return await handleGetState(res);
    if (pathname === '/api/open' && req.method === 'POST') return await handleOpen(req, res);
    if (pathname === '/api/save' && req.method === 'POST') return await handleSave(req, res);
    if (pathname === '/api/create' && req.method === 'POST') return await handleCreate(req, res);
    if (pathname === '/api/rename' && req.method === 'POST') return await handleRename(req, res);
    if (pathname === '/api/upload-image' && req.method === 'POST') return await handleUploadImage(req, res);
    return await serveStatic(res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

if (process.argv.includes('--self-check')) {
  const assert = require('assert');
  const c = classifyChange;
  assert.strictEqual(c('docs/readme.md'), 'file');
  assert.strictEqual(c('data/rows.csv'), 'file');
  assert.strictEqual(c(path.join('src', 'Foo.java')), 'ignore');
  assert.strictEqual(c(path.join('src', 'Foo.class')), 'ignore');
  assert.strictEqual(c('app.iml'), 'ignore');
  assert.strictEqual(c(path.join('target', 'classes', 'x.md')), 'ignore');
  assert.strictEqual(c(path.join('.idea', 'workspace.xml')), 'ignore');
  assert.strictEqual(c(path.join('docs', 'guide')), 'tree');
  assert.strictEqual(c(path.join('.claude', 'notes.md')), 'file');
  console.log('self-check ok');
  process.exit(0);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n  md-reader 已啟動');
  console.log('  在瀏覽器打開： http://localhost:' + PORT + '\n');
  console.log('  掃描目錄：');
  for (const r of ROOTS) console.log('   - ' + r.label + '  (' + r.dir + ')');
  console.log('\n  按 Ctrl+C 結束\n');
});
