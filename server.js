const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');

// Дані зберігаються ПОЗА кодом: на Railway — у Volume (змонтований диск),
// тому теги й коментарі переживають редеплої та заміну index.html.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'annotations.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BASIC_AUTH = process.env.BASIC_AUTH || ''; // необов'язково: "логін:пароль"

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---------- сховище ----------
fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
  console.warn('⚠️  Volume не під\'єднано: дані зітруться при наступному деплої. Додайте Volume з mount path /data.');
}

function emptyState() { return { version: 1, tags: [], articles: {} }; }
let state = emptyState();
try {
  state = Object.assign(emptyState(), JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  console.log(`Завантажено: ${state.tags.length} тегів, ${Object.keys(state.articles).length} статей з анотаціями`);
} catch (e) {
  if (e.code !== 'ENOENT') { console.error('Не вдалося прочитати', DATA_FILE, e); process.exit(1); }
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, DATA_FILE); // атомарний запис
    const day = new Date().toISOString().slice(0, 10);
    const bk = path.join(BACKUP_DIR, `annotations-${day}.json`);
    fs.copyFileSync(DATA_FILE, bk); // щоденна копія (остання за день)
    const old = fs.readdirSync(BACKUP_DIR).sort().slice(0, -30); // тримаємо 30 днів
    old.forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  }, 300);
}

function cleanArticle(url) {
  const a = state.articles[url];
  if (a && !a.tag && !a.comment) delete state.articles[url];
}

// ---------- HTTP-утиліти ----------
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object';
  res.writeHead(code, { 'Content-Type': isObj ? TYPES['.json'] : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function str(v, max) { return String(v ?? '').trim().slice(0, max); }

// ---------- API ----------
async function api(req, res, p) {
  const m = req.method;
  if (p === '/api/state' && m === 'GET') return send(res, 200, state);

  if (p === '/api/tags' && m === 'POST') {
    const b = await readBody(req);
    const name = str(b.name, 60);
    if (!name) return send(res, 400, { error: 'Назва тегу порожня' });
    if (state.tags.some(t => t.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'Такий тег уже є' });
    const tag = { id: crypto.randomUUID().slice(0, 8), name, color: COLOR_RE.test(b.color) ? b.color : '#5A3F8C' };
    state.tags.push(tag); persist();
    return send(res, 201, tag);
  }

  if (p === '/api/tags/order' && m === 'PUT') {
    const b = await readBody(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    const byId = new Map(state.tags.map(t => [t.id, t]));
    const ordered = ids.map(id => byId.get(id)).filter(Boolean);
    state.tags.forEach(t => { if (!ordered.includes(t)) ordered.push(t); });
    state.tags = ordered; persist();
    return send(res, 200, state.tags);
  }

  const tm = p.match(/^\/api\/tags\/([\w-]+)$/);
  if (tm) {
    const tag = state.tags.find(t => t.id === tm[1]);
    if (!tag) return send(res, 404, { error: 'Тег не знайдено' });
    if (m === 'PATCH') {
      const b = await readBody(req);
      if (b.name !== undefined) {
        const name = str(b.name, 60);
        if (!name) return send(res, 400, { error: 'Назва тегу порожня' });
        if (state.tags.some(t => t !== tag && t.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'Такий тег уже є' });
        tag.name = name;
      }
      if (b.color !== undefined && COLOR_RE.test(b.color)) tag.color = b.color;
      persist();
      return send(res, 200, tag);
    }
    if (m === 'DELETE') {
      state.tags = state.tags.filter(t => t !== tag);
      let n = 0;
      for (const url of Object.keys(state.articles)) {
        if (state.articles[url].tag === tag.id) { state.articles[url].tag = null; n++; cleanArticle(url); }
      }
      persist();
      return send(res, 200, { deleted: tag.id, unassigned: n });
    }
  }

  if (p === '/api/article' && m === 'PUT') {
    const b = await readBody(req);
    const url = str(b.url, 1000);
    if (!url) return send(res, 400, { error: 'Немає url' });
    const a = state.articles[url] || { tag: null, comment: '' };
    if (b.tag !== undefined) {
      if (b.tag && !state.tags.some(t => t.id === b.tag)) return send(res, 400, { error: 'Невідомий тег' });
      a.tag = b.tag || null;
    }
    if (b.comment !== undefined) a.comment = str(b.comment, 2000);
    a.updated = new Date().toISOString();
    state.articles[url] = a; cleanArticle(url); persist();
    return send(res, 200, state.articles[url] || { tag: null, comment: '' });
  }

  if (p === '/api/export' && m === 'GET') {
    return send(res, 200, state, { 'Content-Disposition': `attachment; filename="annotations-${new Date().toISOString().slice(0, 10)}.json"` });
  }

  if (p === '/api/import' && m === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.tags) || typeof b.articles !== 'object') return send(res, 400, { error: 'Невірний формат файлу' });
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `before-import-${Date.now()}.json`));
    state = Object.assign(emptyState(), { tags: b.tags, articles: b.articles }); persist();
    return send(res, 200, { ok: true, tags: state.tags.length, articles: Object.keys(state.articles).length });
  }

  send(res, 404, { error: 'Not found' });
}

// ---------- статика ----------
// До кожної HTML-сторінки звіту автоматично підключається annotations.js,
// тож новий index.html можна просто покласти замість старого.
const INJECT = '<link rel="stylesheet" href="/annotations.css"><script src="/annotations.js" defer></script>';

function serveStatic(req, res, p) {
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(file);
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const isReport = ext === '.html' && !/^(tags)\.html$/.test(path.basename(file));
    if (isReport) {
      let html = fs.readFileSync(file, 'utf8');
      if (!html.includes('/annotations.js')) {
        const i = html.lastIndexOf('</body>');
        html = i >= 0 ? html.slice(0, i) + INJECT + html.slice(i) : html + INJECT;
      }
      const buf = Buffer.from(html);
      if (gzip) { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync(buf)); }
      res.writeHead(200, headers); return res.end(buf);
    }
    const stream = fs.createReadStream(file);
    if (gzip) { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }); stream.pipe(zlib.createGzip()).pipe(res); }
    else { res.writeHead(200, headers); stream.pipe(res); }
  });
}

function authorized(req) {
  if (!BASIC_AUTH) return true;
  const h = req.headers.authorization || '';
  const given = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString();
  const a = Buffer.from(given), b = Buffer.from(BASIC_AUTH);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

http.createServer(async (req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { return send(res, 400, 'Bad request'); }
  if (p === '/health') return send(res, 200, { ok: true, dataDir: DATA_DIR, volume: !!(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR) });
  if (!authorized(req)) return send(res, 401, 'Потрібна авторизація', { 'WWW-Authenticate': 'Basic realm="Blog report", charset="UTF-8"' });
  if (p === '/tags') p = '/tags.html';
  try {
    if (p.startsWith('/api/')) return await api(req, res, p);
    serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    send(res, 400, { error: 'Помилка запиту' });
  }
}).listen(PORT, () => console.log(`Listening on ${PORT}, data: ${DATA_FILE}`));
