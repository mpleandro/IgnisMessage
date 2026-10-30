const crypto = require('crypto');
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

async function postWebhook(cfg, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.headerName && cfg.headerValue) headers[cfg.headerName] = cfg.headerValue;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
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

function validateConfig(body) {
  let url;
  try {
    url = new URL(body.webhookUrl);
  } catch {
    return 'URL do webhook inválida';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'URL do webhook deve ser http(s)';
  return null;
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
    const result = await postWebhook(cfg, {
      campaign_id: c.id,
      index: i + 1,
      total: c.items.length,
      phone: item.phone,
      message: item.message,
      fields: item.fields || {},
    });
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
  const err = validateConfig(req.body);
  if (err) return res.status(400).json({ error: err });
  const item = req.body.item || {};
  const result = await postWebhook(req.body, {
    campaign_id: 'teste',
    index: 1,
    total: 1,
    phone: item.phone,
    message: item.message,
    fields: item.fields || {},
  });
  res.json(result);
});

app.post('/api/campaigns', (req, res) => {
  const err = validateConfig(req.body);
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
      webhookUrl: req.body.webhookUrl,
      headerName: req.body.headerName,
      headerValue: req.body.headerValue,
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
