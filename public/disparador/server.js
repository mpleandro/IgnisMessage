const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const PORT = process.env.PORT || 3000;
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

const app = express();
app.use(express.json({ limit: '50mb' }));

// ---------- Autenticação (tela de login + cookie de sessão assinado) ----------
app.set('trust proxy', true);
const SESSION_SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('disparador|' + APP_PASSWORD).digest('hex');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE = 'disp_session';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ u: APP_USER, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return payload + '.' + sign(payload);
}
function validToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.u === APP_USER && d.exp > Date.now();
  } catch { return false; }
}
function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
const isAuthed = (req) => !APP_PASSWORD || validToken(getCookie(req, COOKIE));

// limite de tentativas por IP: 8 falhas / 10 min
const attempts = new Map();
function tooMany(ip) {
  const a = attempts.get(ip);
  return a && a.until > Date.now() && a.count >= 8;
}
function noteFail(ip) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { count: 1, until: Date.now() + 10 * 60 * 1000 });
  else a.count++;
}

// Assets visuais (logo) são públicos para a tela de login poder usá-los.
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  const { user, password } = req.body || {};
  if (APP_PASSWORD && safeEqual(user || '', APP_USER) && safeEqual(password || '', APP_PASSWORD)) {
    attempts.delete(ip);
    res.cookie(COOKIE, makeToken(), {
      httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_TTL_MS, path: '/',
    });
    return res.json({ ok: true });
  }
  noteFail(ip);
  res.status(401).json({ error: 'Usuário ou senha incorretos.' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/papaparse.min.js', (req, res) =>
  res.sendFile(require.resolve('papaparse/papaparse.min.js'))
);

// ---------- Fila de disparos ----------
const campaigns = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// ---------- Configurações (N8N / Evolution), salvas em disco ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  mode: 'n8n', // 'n8n' = o N8N envia | 'evolution' = o servidor chama a Evolution API direto
  n8n: { url: '', headerName: '', headerValue: '' },
  evolution: { baseUrl: '', apiKey: '', instance: '', version: 'v2' },
};

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      mode: saved.mode === 'evolution' ? 'evolution' : 'n8n',
      n8n: { ...DEFAULT_SETTINGS.n8n, ...saved.n8n },
      evolution: { ...DEFAULT_SETTINGS.evolution, ...saved.evolution },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function persistSettings(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
}

let settings = loadSettings();

const isHttpUrl = (u) => {
  try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; }
};
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Retorna o motivo pelo qual o destino ativo não pode ser usado, ou null.
function destError(s) {
  if (s.mode === 'evolution') {
    const e = s.evolution;
    if (!isHttpUrl(e.baseUrl)) return 'Configure a URL da Evolution API em Configurações';
    if (!e.apiKey) return 'Configure a API Key da Evolution em Configurações';
    if (!e.instance) return 'Configure o nome da instância da Evolution em Configurações';
    return null;
  }
  if (!isHttpUrl(s.n8n.url)) return 'Configure a URL do webhook do N8N em Configurações';
  return null;
}

const mask = (v) => (v ? '••••••' + v.slice(-4) : '');
function publicSettings(s) {
  return {
    mode: s.mode,
    n8n: { url: s.n8n.url, headerName: s.n8n.headerName, headerValueMasked: mask(s.n8n.headerValue) },
    evolution: {
      baseUrl: s.evolution.baseUrl, instance: s.evolution.instance, version: s.evolution.version,
      apiKeyMasked: mask(s.evolution.apiKey),
    },
    ready: !destError(s),
  };
}

app.get('/api/settings', (req, res) => res.json(publicSettings(settings)));

app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const next = structuredClone(settings);
  next.mode = b.mode === 'evolution' ? 'evolution' : 'n8n';
  if (b.n8n) {
    const url = str(b.n8n.url);
    if (url && !isHttpUrl(url)) return res.status(400).json({ error: 'URL do webhook do N8N inválida (use http:// ou https://)' });
    next.n8n.url = url;
    next.n8n.headerName = str(b.n8n.headerName);
    if (typeof b.n8n.headerValue === 'string' && b.n8n.headerValue) next.n8n.headerValue = b.n8n.headerValue; // vazio = mantém
    if (!next.n8n.headerName) next.n8n.headerValue = '';
  }
  if (b.evolution) {
    const base = str(b.evolution.baseUrl).replace(/\/+$/, '');
    if (base && !isHttpUrl(base)) return res.status(400).json({ error: 'URL da Evolution API inválida (use http:// ou https://)' });
    next.evolution.baseUrl = base;
    next.evolution.instance = str(b.evolution.instance);
    next.evolution.version = b.evolution.version === 'v1' ? 'v1' : 'v2';
    if (typeof b.evolution.apiKey === 'string' && b.evolution.apiKey.trim()) next.evolution.apiKey = b.evolution.apiKey.trim(); // vazio = mantém
  }
  const err = destError(next);
  if (err) return res.status(400).json({ error: err.replace(' em Configurações', '') });
  try { persistSettings(next); } catch (e) { return res.status(500).json({ error: 'Não foi possível salvar: ' + e.message }); }
  settings = next;
  res.json(publicSettings(settings));
});

// ---------- Envio ----------
async function http(url, { method = 'POST', headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, status: 0, body: err.name === 'AbortError' ? 'timeout (30s)' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

const evoUrl = (e, route) => `${e.baseUrl.replace(/\/+$/, '')}${route}/${encodeURIComponent(e.instance)}`;

// Entrega uma mensagem pelo destino configurado (N8N ou Evolution direto).
function deliver(dest, item, meta) {
  if (dest.mode === 'evolution') {
    const e = dest.evolution;
    const body = e.version === 'v1'
      ? { number: item.phone, textMessage: { text: item.message } }
      : { number: item.phone, text: item.message };
    return http(evoUrl(e, '/message/sendText'), { headers: { apikey: e.apiKey }, body });
  }
  const n = dest.n8n;
  const headers = n.headerName && n.headerValue ? { [n.headerName]: n.headerValue } : {};
  return http(n.url, {
    headers,
    body: { ...meta, phone: item.phone, message: item.message, fields: item.fields || {} },
  });
}

// ---------- Janela de envio (horário de Brasília) ----------
const TZ = 'America/Sao_Paulo';
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});

function brasiliaNow() {
  const parts = Object.fromEntries(clockFmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { minutes: Number(parts.hour) * 60 + Number(parts.minute), day: WEEKDAYS[parts.weekday] };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function inWindow(cfg) {
  if (!cfg.windowEnabled) return true;
  const { minutes, day } = brasiliaNow();
  if (cfg.days.length && !cfg.days.includes(day)) return false;
  const start = toMinutes(cfg.windowStart);
  const end = toMinutes(cfg.windowEnd);
  if (start === end) return true;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

async function runCampaign(c) {
  const { cfg } = c;
  let sinceBatch = 0;
  while (c.cursor < c.items.length) {
    while (c.status === 'paused') await sleep(500);
    if (c.status === 'canceled') return;
    while (!inWindow(cfg) && c.status !== 'canceled') {
      c.waitingWindow = true;
      await sleep(1000);
    }
    c.waitingWindow = false;
    if (c.status === 'canceled') return;
    if (c.status === 'paused') continue;

    const i = c.cursor;
    const item = c.items[i];
    const result = await deliver(cfg.dest, item, { campaign_id: c.id, index: i + 1, total: c.items.length });
    c.cursor++;
    if (result.ok) c.sent++;
    else c.failed++;
    c.log.push({ index: i + 1, phone: item.phone, ok: result.ok, status: result.status, info: result.ok ? '' : result.body, at: Date.now() });
    if (c.log.length > 500) c.log.shift();

    if (c.cursor >= c.items.length) break;
    sinceBatch++;
    if (cfg.batchSize > 0 && sinceBatch >= cfg.batchSize) {
      sinceBatch = 0;
      c.nextAt = Date.now() + cfg.batchPause * 1000;
      await sleepInterruptible(c, cfg.batchPause * 1000);
    } else {
      const wait = rand(cfg.minDelay, cfg.maxDelay) * 1000;
      c.nextAt = Date.now() + wait;
      await sleepInterruptible(c, wait);
    }
    c.nextAt = null;
  }
  if (c.status === 'running') c.status = 'done';
}

async function sleepInterruptible(c, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && c.status !== 'canceled') await sleep(Math.min(250, end - Date.now()));
}

function summary(c, withLog) {
  const out = {
    id: c.id,
    status: c.status,
    total: c.items.length,
    sent: c.sent,
    failed: c.failed,
    createdAt: c.createdAt,
    nextAt: c.nextAt,
    waitingWindow: !!c.waitingWindow,
  };
  if (withLog) out.log = c.log.slice(-100);
  return out;
}

app.post('/api/test', async (req, res) => {
  const err = destError(settings);
  if (err) return res.status(400).json({ error: err });
  const item = req.body.item || {};
  res.json(await deliver(settings, item, { campaign_id: 'teste', index: 1, total: 1 }));
});

// Teste de conexão do destino salvo. Evolution: consulta o estado da instância (não envia nada).
// N8N: envia um ping { event: 'ping', test: true } ao webhook.
app.post('/api/settings/test', async (req, res) => {
  const target = req.body && req.body.target === 'evolution' ? 'evolution' : 'n8n';
  const probe = { ...settings, mode: target };
  const err = destError(probe);
  if (err) return res.status(400).json({ error: err });
  if (target === 'evolution') {
    const r = await http(evoUrl(settings.evolution, '/instance/connectionState'), {
      method: 'GET', headers: { apikey: settings.evolution.apiKey },
    });
    let state = null;
    try { const j = JSON.parse(r.body); state = (j.instance && j.instance.state) || j.state || null; } catch {}
    return res.json({ ...r, state });
  }
  const n = settings.n8n;
  const headers = n.headerName && n.headerValue ? { [n.headerName]: n.headerValue } : {};
  res.json(await http(n.url, { headers, body: { event: 'ping', test: true } }));
});

app.post('/api/campaigns', (req, res) => {
  const err = destError(settings);
  if (err) return res.status(400).json({ error: err });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Nenhum contato para enviar' });

  const minDelay = Math.max(0, Number(req.body.minDelay) || 0);
  const maxDelay = Math.max(minDelay, Number(req.body.maxDelay) || minDelay);
  const c = {
    id: crypto.randomUUID(),
    status: 'running',
    items,
    cursor: 0,
    sent: 0,
    failed: 0,
    log: [],
    nextAt: null,
    createdAt: Date.now(),
    cfg: {
      dest: structuredClone(settings), // snapshot: mudar as configurações não afeta campanhas em andamento
      minDelay,
      maxDelay,
      batchSize: Math.max(0, parseInt(req.body.batchSize, 10) || 0),
      batchPause: Math.max(0, Number(req.body.batchPause) || 0),
      windowEnabled: !!req.body.windowEnabled,
      windowStart: /^\d{1,2}:\d{2}$/.test(req.body.windowStart) ? req.body.windowStart : '09:00',
      windowEnd: /^\d{1,2}:\d{2}$/.test(req.body.windowEnd) ? req.body.windowEnd : '18:00',
      days: (Array.isArray(req.body.days) ? req.body.days : []).map(Number).filter((d) => d >= 0 && d <= 6),
    },
  };
  campaigns.set(c.id, c);
  runCampaign(c).catch((e) => {
    c.status = 'error';
    c.log.push({ index: c.cursor, ok: false, status: 0, info: e.message, at: Date.now() });
  });
  res.status(201).json(summary(c));
});

app.get('/api/campaigns', (req, res) => {
  res.json([...campaigns.values()].sort((a, b) => b.createdAt - a.createdAt).map((c) => summary(c)));
});

app.get('/api/campaigns/:id', (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'não encontrada' });
  res.json(summary(c, true));
});

app.post('/api/campaigns/:id/:action', (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'não encontrada' });
  const { action } = req.params;
  if (action === 'pause' && c.status === 'running') c.status = 'paused';
  else if (action === 'resume' && c.status === 'paused') c.status = 'running';
  else if (action === 'cancel' && ['running', 'paused'].includes(c.status)) c.status = 'canceled';
  res.json(summary(c));
});

app.listen(PORT, () => {
  console.log(`Disparador rodando na porta ${PORT}`);
  if (!APP_PASSWORD) console.warn('ATENÇÃO: APP_PASSWORD não definido — a aplicação está sem login!');
});
