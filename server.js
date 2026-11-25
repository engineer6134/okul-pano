// Okul Pano - bağımlılıksız Node.js sunucu (Node 18+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
[DATA_DIR, UPLOAD_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

function monthLabel(iso) {
  const M = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  return iso && /^\d{4}-\d{2}/.test(iso) ? M[+iso.slice(5, 7) - 1] + ' ' + iso.slice(0, 4) : 'Çizelge';
}
const emptyDays = () => ({ days: { 1: [], 2: [], 3: [], 4: [], 5: [] } });

const DEFAULT_DB = {
  version: 1,
  settings: {
    schoolName: '',
    logoLeft: '',           // yüklenen sol logo (/uploads/...)
    logoRight: '',          // yüklenen sağ logo (/uploads/...)
    theme: 'blue',          // blue | green | red | dark
    showClock: true,
    showWeather: false,
    slideSeconds: 10,
    tickerSpeed: 60,
    layout: 'split',        // split | full
    imageFit: 'cover'       // cover (alanı kapla) | contain (sığdır)
  },
  announcements: [],        // {id,text,active}
  slides: [],               // {id,url,caption,active}
  youtube: { url: '', active: false, muted: true },
  modules: [],              // {id,title,html,active}
  specials: [],             // özel gün sayfaları: {id,title,file,image,from,to,timeFrom,timeTo,active,pinned,hideControls,autoStart,useTeachers}
  teachers: [],             // {id,name,role?}  role: 'mudur' | 'yardimci'
  duty: { schedules: [] },  // aylık çizelgeler: {id,name,validFrom,validTo,vice,places:[{id,name}],cells:{'yerId|gün':öğretmenId}}
  birthdays: [],            // {id,name,className,date(MM-DD)}
  schedule: emptyDays(),    // {days:{1..5:[{label,start,end,type}]}}
  news: {                   // okul sitesinden çekilen haberler
    url: '',
    active: false,
    count: 8,
    intervalMin: 30,        // kaç dakikada bir güncellensin
    showText: true,         // panoda haber metni (başlık/özet/tarih) gösterilsin
    showImage: true,        // panoda haber görseli gösterilsin
    prefs: { hidden: {}, order: [], deleted: {} },  // haber başına gizleme ve sıralama (bağlantıya göre)
    items: [],              // {title,date,summary,image,link}
    fetchedAt: null,
    error: null
  },
  lastPing: null
};

// Öğretmen görevi: role = 'mudur' (en fazla 1 kişi) | 'yardimci' (müdür yardımcısı); diğerlerinde alan yoktur
function cleanTeachers(arr) {
  let haveHead = false;
  return (Array.isArray(arr) ? arr : []).map(t => {
    const o = { id: String(t.id || ''), name: String(t.name || '').slice(0, 80) };
    if (t.role === 'mudur' && !haveHead) { o.role = 'mudur'; haveHead = true; }
    else if (t.role === 'yardimci' || t.role === 'mudur') o.role = 'yardimci';
    return o;
  }).filter(t => t.id && t.name);
}

let db;
function normalize() {
  let m = false;
  if (!db.settings) { db.settings = JSON.parse(JSON.stringify(DEFAULT_DB.settings)); m = true; }
  if (!Array.isArray(db.teachers)) { db.teachers = []; m = true; }
  else db.teachers = cleanTeachers(db.teachers);
  if (!Array.isArray(db.specials)) { db.specials = []; m = true; }
  if (!db.duty || typeof db.duty !== 'object' || Array.isArray(db.duty)) { db.duty = { schedules: [] }; m = true; }
  else if (!Array.isArray(db.duty.schedules)) {
    const o = db.duty;   // eski tek çizelgeli biçim
    db.duty = o.places ? { schedules: [{ id: 'd1', name: monthLabel(o.validFrom), places: o.places, cells: o.cells || {}, validFrom: o.validFrom || '', validTo: o.validTo || '', vice: o.vice || '' }] } : { schedules: [] };
    m = true;
  }
  if (!db.schedule || !db.schedule.days) { db.schedule = emptyDays(); m = true; }
  if (!db.news) db.news = JSON.parse(JSON.stringify(DEFAULT_DB.news));
  if (!db.news.prefs) db.news.prefs = { hidden: {}, order: [], deleted: {} };
  if (!db.news.prefs.deleted) db.news.prefs.deleted = {};
  return m;
}
function loadDb() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { db = JSON.parse(JSON.stringify(DEFAULT_DB)); saveDb(); }
  for (const k of Object.keys(DEFAULT_DB)) if (!(k in db)) db[k] = JSON.parse(JSON.stringify(DEFAULT_DB[k]));
  if (normalize()) { db.version = (db.version || 1) + 1; saveDb(); }
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
loadDb();

// ---- Yönetici şifresi: panelden değiştirilince tuzlu hash olarak data/auth.json'a yazılır ----
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
let auth = null;
try { auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch {}
const sha = x => crypto.createHash('sha256').update(String(x)).digest();
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function checkPass(pw) {
  pw = String(pw || '');
  if (!auth) return crypto.timingSafeEqual(sha(pw), sha(ADMIN_PASS));
  const a = Buffer.from(hashPw(pw, auth.salt), 'hex'), b = Buffer.from(auth.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setPass(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  auth = { salt, hash: hashPw(pw, salt), changedAt: new Date().toISOString() };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
}

const SECTIONS = ['settings', 'announcements', 'slides', 'youtube', 'modules', 'specials', 'duty', 'birthdays', 'schedule', 'teachers'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.ico': 'image/x-icon'
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function isAdmin(req) { let k = req.headers['x-admin-key'] || ''; try { k = decodeURIComponent(k); } catch {} return checkPass(k); }
function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Bulunamadı' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': file.startsWith(UPLOAD_DIR) ? 'public, max-age=86400' : 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}
function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
}
// ---- Okul sitesi haberleri (MEB okul sitesi kart yapısı) ----
function stripTags(s) {
  return String(s).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function parseNews(html, base) {
  const re = /<a\b[^>]*href=["']([^"']*\/icerikler\/[^"']*?_(\d+)\.html)["'][^>]*>/gi;
  const hits = []; const seen = new Set(); let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[2])) continue; seen.add(m[2]);
    let href; try { href = new URL(m[1].trim(), base).href; } catch { continue; }
    hits.push({ id: m[2], href, pos: m.index });
  }
  const items = [];
  hits.forEach((h, i) => {
    const seg = html.slice(h.pos, Math.min(hits[i + 1] ? hits[i + 1].pos : Infinity, h.pos + 6000));
    // Resim: yalnızca gerçek haber görseli (yer tutucu mansetresim.png vb. atlanır)
    let img = null, im; const ire = /(?:data-src|src)=["']([^"']+)["']/gi;
    while ((im = ire.exec(seg))) { if (/resimler\//i.test(im[1])) { img = im[1]; break; } }
    if (!img) return;
    let imageRemote; try { imageRemote = new URL(img.trim().replace(/ /g, '%20'), base).href; } catch { return; }
    const dm = seg.match(/\b(\d{2})[-.\/](\d{2})[-.\/](\d{4})\b/);
    const date = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : '';
    // Başlık: bu habere giden, "Devamını Oku" olmayan ilk metinli bağlantı
    let title = '', titleHtml = '';
    const are = new RegExp('<a\\b[^>]*href=["\'][^"\']*_' + h.id + '\\.html["\'][^>]*>([\\s\\S]*?)</a>', 'gi'); let am;
    while ((am = are.exec(seg))) {
      const t = stripTags(am[1]);
      if (t && !/devam[ıi]n[ıi] oku/i.test(t)) { title = t; titleHtml = am[0]; break; }
    }
    if (!title) { const al = seg.match(/\b(?:alt|title)=["']([^"']{4,})["']/i); title = al ? stripTags(al[1]) : ''; }
    if (!title) { try { title = decodeURIComponent(h.href.split('/').pop().replace(/_\d+\.html$/, '')).replace(/-/g, ' '); } catch { title = 'Haber'; } }
    // Özet: başlıktan sonraki metin, "Devamını Oku"ya kadar
    let rest = titleHtml ? seg.slice(seg.indexOf(titleHtml) + titleHtml.length) : seg;
    rest = stripTags(rest).split(/devam[ıi]n[ıi] oku/i)[0].replace(dm ? dm[0] : '', '').trim();
    let summary = rest === title ? '' : rest;
    summary = summary.replace(/^[-–:>\s]+/, '').slice(0, 220);
    items.push({ title: title.slice(0, 160), date, summary, imageRemote, link: h.href });
  });
  return items;
}
// Liste sayfasındaki görseller küçük önizlemedir (dosya adı k_ ile başlar); aynı klasördeki k_'sız dosya orijinal boyuttur.
const isImg = b => b && b.length > 1500 && ((b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0x47 && b[1] === 0x49) || (b[0] === 0x52 && b[1] === 0x49));
function hiResUrl(u) {
  try { const x = new URL(u); const parts = x.pathname.split('/'); const f = parts.pop(); if (!/^k_/i.test(f)) return null; parts.push(f.replace(/^k_/i, '')); x.pathname = parts.join('/'); return x.href; } catch { return null; }
}
async function downloadNewsImage(u) {
  const hi = hiResUrl(u);
  if (hi) { try { const b = await httpGet(hi, true); if (isImg(b)) return b; } catch {} }
  return httpGet(u, true);
}
async function httpGet(u, asBuf) {
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (OkulPano)', 'Accept-Language': 'tr' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return asBuf ? Buffer.from(await r.arrayBuffer()) : r.text();
}
// Kullanıcının sıralama ve gizleme tercihlerini uygular; yeni haberler en üste gelir
function applyNewsPrefs() {
  const n = db.news, pr = n.prefs;
  const pos = new Map(pr.order.map((l, i) => [l, i]));
  const fresh = n.items.filter(i => !pos.has(i.link));
  const known = n.items.filter(i => pos.has(i.link)).sort((a, b) => pos.get(a.link) - pos.get(b.link));
  n.items = [...fresh, ...known];
  pr.order = n.items.map(i => i.link);
  n.items.forEach(i => { i.hidden = !!pr.hidden[i.link]; });
}
// ---- Haber arşivi: bir haber bir kez indirilir, çevrimdışı saklanır, otomatik silinmez ----
const NEWS_ARCHIVE_MAX = 200;
function dropNewsImage(img) {
  if (!img || !img.startsWith('/uploads/news-')) return;
  if (db.news.items.some(i => i.image === img)) return;       // başka haber kullanıyorsa dokunma
  try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(img))); } catch {}
}
function deleteNewsItem(link) {
  const n = db.news, i = n.items.findIndex(x => x.link === link);
  if (i < 0) return false;
  const [it] = n.items.splice(i, 1);
  n.prefs.deleted[link] = true;                                // site sayfasında hâlâ varsa tekrar eklenmesin
  delete n.prefs.hidden[link];
  n.prefs.order = n.prefs.order.filter(l => l !== link);
  dropNewsImage(it.image);
  db.version++;
  return true;
}
// Tüm haber arşivini temizler. mode 'ignore': sitede şu an görünen haberler de yoksayılır (yalnızca yeni çıkanlar eklenir);
// mode 'refetch': arşiv sıfırlanır ve sitedeki güncel haberler yeniden çekilir.
async function clearNews(mode) {
  const n = db.news;
  const old = n.items.map(i => i.link);
  n.items = []; n.prefs.hidden = {}; n.prefs.order = [];
  for (const f of fs.readdirSync(UPLOAD_DIR)) if (f.startsWith('news-')) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch {} }
  n.etag = ''; n.lastModified = '';
  let ignored = 0, warn = null, added = 0;
  if (mode === 'refetch') {
    n.prefs.deleted = {};
  } else {
    old.forEach(l => { n.prefs.deleted[l] = true; });
    if (n.url) {
      try { for (const it of parseNews(await httpGet(n.url), n.url)) { n.prefs.deleted[it.link] = true; ignored++; } }
      catch (e) { warn = 'Okul sitesine ulaşılamadı; yalnızca arşivdeki haberler yoksayıldı (' + e.message + ')'; }
    }
  }
  n.error = null; n.fetchedAt = null; n.lastNewAt = null;
  db.version++; saveDb();
  if (mode === 'refetch') added = await refreshNews(true);
  return { added, ignored, warn };
}
let newsBusy = false, lastTry = 0;
// Döndürdüğü değer: eklenen yeni haber sayısı
async function refreshNews(force) {
  const n = db.news;
  if (newsBusy || (!force && !n.active)) return 0;
  newsBusy = true; lastTry = Date.now();
  let added = 0;
  try {
    if (!n.url) throw new Error('Site adresi girilmemiş');
    // Tek istek: haber listesi sayfası. Site destekliyorsa değişmediyse 304 döner ve hiçbir şey indirilmez.
    const headers = { 'User-Agent': 'Mozilla/5.0 (OkulPano)', 'Accept-Language': 'tr' };
    if (!force && n.etag) headers['If-None-Match'] = n.etag;
    if (!force && n.lastModified) headers['If-Modified-Since'] = n.lastModified;
    const r = await fetch(n.url, { headers, signal: AbortSignal.timeout(20000) });
    n.checkedAt = new Date().toISOString();
    if (r.status === 304) { n.error = null; return 0; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    n.etag = r.headers.get('etag') || ''; n.lastModified = r.headers.get('last-modified') || '';
    const parsed = parseNews(await r.text(), n.url);
    if (!parsed.length) throw new Error('Sayfada resimli haber bulunamadı');
    // Yalnızca arşivde olmayan ve silinmemiş haberler işlenir
    const known = new Set(n.items.map(i => i.link));
    const fresh = parsed.filter(i => !known.has(i.link) && !n.prefs.deleted[i.link]);
    const toAdd = [];
    for (const it of fresh) {
      try {
        const ext = path.extname(new URL(it.imageRemote).pathname).toLowerCase();
        const name = 'news-' + crypto.createHash('md5').update(it.imageRemote).digest('hex').slice(0, 16) + (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg');
        const f = path.join(UPLOAD_DIR, name);
        if (!fs.existsSync(f)) fs.writeFileSync(f, await downloadNewsImage(it.imageRemote));
        const { imageRemote, ...rest } = it;
        toAdd.push({ ...rest, image: '/uploads/' + name, addedAt: new Date().toISOString() });
      } catch { /* görsel inemedi: arşive eklenmez, bir sonraki kontrolte yeniden denenir */ }
    }
    if (toAdd.length) {
      n.items = [...toAdd, ...n.items];
      applyNewsPrefs();
      while (n.items.length > NEWS_ARCHIVE_MAX) { const old = n.items.pop(); n.prefs.order = n.prefs.order.filter(l => l !== old.link); dropNewsImage(old.image); }
      n.lastNewAt = new Date().toISOString();
      db.version++; added = toAdd.length;
    }
    n.error = null; n.fetchedAt = new Date().toISOString();
  } catch (e) {
    n.error = e.message + (e.cause && e.cause.code ? ' (' + e.cause.code + ')' : '');
  } finally { newsBusy = false; saveDb(); }
  return added;
}
// Hava durumu sunucudan çekilir (TV tarayıcısının internete/eklentilere bağımlı olmaması için); 15 dk önbelleklenir
let wxCache = null, wxErr = '';
async function getWeather() {
  const st = db.settings || {};
  if (!st.showWeather) { wxErr = '"Hava durumunu göster" ayarı kapalı'; return null; }
  if (st.weatherLat == null) { wxErr = 'Şehir seçilmemiş (Şehri Bul ve Kaydet)'; return null; }
  const key = st.weatherLat + ',' + st.weatherLon;
  if (wxCache && wxCache.key === key && Date.now() - wxCache.at < 15 * 60 * 1000) return wxCache.data;
  try {
    const base = process.env.WEATHER_URL || 'https://api.open-meteo.com/v1/forecast';
    const r = await fetch(`${base}?latitude=${encodeURIComponent(st.weatherLat)}&longitude=${encodeURIComponent(st.weatherLon)}&current=temperature_2m,weather_code&timezone=auto`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const c = (await r.json()).current;
    if (!c || typeof c.temperature_2m !== 'number') throw new Error('Geçersiz yanıt');
    wxCache = { key, at: Date.now(), data: { temp: c.temperature_2m, code: c.weather_code } };
    wxErr = '';
    return wxCache.data;
  } catch (e) {
    const why = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    if (why !== wxErr) console.log('Hava durumu alınamadı:', why);
    wxErr = String(why);
    return wxCache && wxCache.key === key ? wxCache.data : null;   // internet yoksa son değer
  }
}

function publicState() {
  const { lastPing, ...rest } = db;
  return rest;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);

    // ---- API ----
    if (p.startsWith('/api/')) {
      if (p === '/api/state' && req.method === 'GET') return send(res, 200, publicState());
      if (p === '/api/weather' && req.method === 'GET') { const w = await getWeather(); return w ? send(res, 200, w) : send(res, 503, { error: 'Hava durumu alınamadı', neden: wxErr }); }
      if (p === '/api/version' && req.method === 'GET') return send(res, 200, { version: db.version });
      if (p === '/api/ping' && req.method === 'POST') {
        db.lastPing = { at: new Date().toISOString(), ua: String(req.headers['user-agent'] || '').slice(0, 120), ip: req.socket.remoteAddress };
        return send(res, 200, { ok: true });
      }
      if (p === '/api/login' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
        return checkPass(b.password) ? send(res, 200, { ok: true }) : send(res, 401, { error: 'Şifre hatalı' });
      }

      // Aşağısı yönetici gerektirir
      if (!isAdmin(req)) return send(res, 401, { error: 'Yetkisiz' });

      if (p === '/api/password' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
        if (!checkPass(b.current)) return send(res, 400, { error: 'Mevcut şifre hatalı' });
        const nx = String(b.next || '');
        if (nx.length < 6) return send(res, 400, { error: 'Yeni şifre en az 6 karakter olmalı' });
        setPass(nx);
        return send(res, 200, { ok: true });
      }

      if (p === '/api/health' && req.method === 'GET') {
        let uploadBytes = 0, uploadCount = 0;
        for (const f of fs.readdirSync(UPLOAD_DIR)) { uploadBytes += fs.statSync(path.join(UPLOAD_DIR, f)).size; uploadCount++; }
        return send(res, 200, {
          serverTime: new Date().toISOString(), uptime: Math.round(process.uptime()),
          version: db.version, lastPing: db.lastPing, uploadBytes, uploadCount,
          node: process.version, memoryMB: Math.round(process.memoryUsage().rss / 1048576)
        });
      }
      if (p === '/api/reset' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
        if (b.confirm !== 'SIFIRLA') return send(res, 400, { error: 'Onay metni hatalı' });
        const ver = (db.version || 1) + 1;
        db = JSON.parse(JSON.stringify(DEFAULT_DB)); db.version = ver;
        for (const f of fs.readdirSync(UPLOAD_DIR)) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch {} }
        if (b.resetPassword) { try { fs.unlinkSync(AUTH_FILE); } catch {} auth = null; }
        saveDb();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/news/refresh' && req.method === 'POST') {
        const added = await refreshNews(true);
        return send(res, 200, { ok: !db.news.error, error: db.news.error, added, count: db.news.items.length });
      }
      if (p === '/api/news/clear' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
        const r = await clearNews(b.mode === 'refetch' ? 'refetch' : 'ignore');
        return send(res, 200, { ok: true, ...r, count: db.news.items.length });
      }
      if (p === '/api/news/delete' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
        const ok = deleteNewsItem(String(b.link || ''));
        saveDb();
        return send(res, 200, { ok });
      }
      const m = p.match(/^\/api\/state\/(\w+)$/);
      if (m && m[1] === 'news' && req.method === 'PUT') {
        const b = JSON.parse((await readBody(req, 100000)).toString());
        db.news.url = String(b.url || '').trim().slice(0, 300);
        db.news.active = !!b.active;
        db.news.count = Math.min(Math.max(+b.count || 8, 1), 20);
        db.news.intervalMin = Math.min(Math.max(+b.intervalMin || 30, 5), 1440);
        db.news.showText = b.showText !== false;
        db.news.showImage = b.showImage !== false;
        if (!db.news.showText && !db.news.showImage) db.news.showText = true;
        if (b.hidden && typeof b.hidden === 'object' && !Array.isArray(b.hidden)) db.news.prefs.hidden = b.hidden;
        if (Array.isArray(b.order)) db.news.prefs.order = b.order.map(String);
        applyNewsPrefs();
        db.version++; saveDb();
        return send(res, 200, { ok: true, version: db.version });
      }
      if (m && req.method === 'PUT') {
        if (!SECTIONS.includes(m[1])) return send(res, 400, { error: 'Geçersiz bölüm' });
        db[m[1]] = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString());
        if (m[1] === 'teachers') db.teachers = cleanTeachers(db.teachers);
        db.version++; saveDb();
        return send(res, 200, { ok: true, version: db.version });
      }
      if (p === '/api/upload' && req.method === 'POST') {
        const orig = decodeURIComponent(req.headers['x-filename'] || 'dosya');
        const ext = path.extname(orig).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.svg', '.html'].includes(ext)) return send(res, 400, { error: 'Desteklenmeyen dosya türü' });
        const name = Date.now() + '-' + Math.random().toString(36).slice(2, 7) + ext;
        fs.writeFileSync(path.join(UPLOAD_DIR, name), await readBody(req));
        return send(res, 200, { url: '/uploads/' + name });
      }
      if (p === '/api/upload' && req.method === 'DELETE') {
        const f = safeJoin(UPLOAD_DIR, path.basename(url.searchParams.get('f') || ''));
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/backup' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="pano-yedek-${new Date().toISOString().slice(0, 10)}.json"` });
        return res.end(JSON.stringify(publicState(), null, 2));
      }
      if (p === '/api/restore' && req.method === 'POST') {
        const data = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString());
        for (const k of SECTIONS) if (k in data) db[k] = data[k];
        if (data.news) Object.assign(db.news, { url: String(data.news.url || ''), active: !!data.news.active, count: +data.news.count || 8, intervalMin: Math.min(Math.max(+data.news.intervalMin || 30, 5), 1440), showText: data.news.showText !== false, showImage: data.news.showImage !== false });
        normalize();
        db.version++; saveDb();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'API bulunamadı' });
    }

    // ---- Statik ----
    if (p.startsWith('/uploads/')) { const f = safeJoin(UPLOAD_DIR, p.slice(9)); return f ? serveFile(res, f) : send(res, 403, {}); }
    let rel = p === '/' ? '/pano.html' : p;
    if (rel === '/admin' || rel === '/settings' || rel.startsWith('/settings/')) rel = '/admin.html';
    if (rel === '/pano') rel = '/pano.html';
    const f = safeJoin(PUBLIC, rel);
    return f ? serveFile(res, f) : send(res, 403, {});
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  setTimeout(() => refreshNews(false), 3000);
  // Her dakika kontrol eder; ayarlanan aralık dolduysa haberleri çeker
  setInterval(() => {
    const n = db.news;
    if (n.active && Date.now() - lastTry >= (n.intervalMin || 30) * 60000) refreshNews(false);
  }, 60 * 1000);
}
module.exports = { parseNews, applyNewsPrefs, getDb: () => db };

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Okul Pano çalışıyor → http://localhost:${PORT}   (TV: /  | Yönetim: /admin)`);
  if (auth) console.log('Yönetici şifresi panelden belirlenmiş (data/auth.json); ADMIN_PASS kullanılmıyor.');
  else if (ADMIN_PASS === 'admin') console.log('UYARI: Varsayılan yönetici şifresi "admin". Yönetim panelinde "Şifre Değiştir" ile değiştirin.');
});
