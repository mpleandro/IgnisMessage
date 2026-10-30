const $ = (id) => document.getElementById(id);
const state = { rows: [], headers: [], defaults: {}, varKey: '', previewIdx: 0, campaignId: null, timer: null };

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// ---------- Persistência local das configurações ----------
for (const id of ['webhookUrl', 'headerName', 'minDelay', 'maxDelay', 'batchSize', 'batchPause', 'ddi', 'windowStart', 'windowEnd']) {
  const saved = localStorage.getItem('disp_' + id);
  if (saved !== null) $(id).value = saved;
  $(id).addEventListener('input', () => localStorage.setItem('disp_' + id, $(id).value));
}

// ---------- CSV ----------
$('csvFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
    complete: (res) => {
      state.rows = res.data;
      state.headers = res.meta.fields || [];
      $('csvInfo').textContent = `${state.rows.length} linhas · colunas: ${state.headers.join(', ')}`;
      $('phoneCol').innerHTML = state.headers.map((h) => `<option>${esc(h)}</option>`).join('');
      const guess = state.headers.find((h) => /(whats|telefone|celular|phone|fone|numero|número)/i.test(h));
      if (guess) $('phoneCol').value = guess;
      $('phoneConfig').hidden = false;
      state.previewIdx = 0;
      renderVars(true);
      renderPreview();
    },
    error: (err) => alert('Erro ao ler CSV: ' + err.message),
  });
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Variáveis ----------
function messageVars() {
  const seen = new Map();
  for (const m of $('message').value.matchAll(VAR_RE)) {
    const name = m[1].trim();
    if (!seen.has(norm(name))) seen.set(norm(name), name);
  }
  return [...seen.values()];
}

function columnFor(name) {
  return state.headers.find((h) => norm(h) === norm(name));
}

function renderVars(force) {
  const vars = messageVars();
  const key = vars.map(norm).join('|') + '#' + state.headers.join('|');
  if (!force && key === state.varKey) return;
  state.varKey = key;
  const box = $('vars');
  box.innerHTML = '';
  for (const name of vars) {
    const col = columnFor(name);
    const row = document.createElement('div');
    row.className = 'var';
    row.innerHTML = `
      <div class="name">{{${esc(name)}}}<span class="tag ${col ? 'ok' : 'no'}">${col ? 'coluna encontrada' : 'sem coluna no CSV'}</span></div>
      <label>Valor padrão (quando vazio)
        <input type="text" value="${esc(state.defaults[norm(name)] || '')}" placeholder="ex.: cliente">
      </label>`;
    row.querySelector('input').addEventListener('input', (e) => {
      state.defaults[norm(name)] = e.target.value;
      renderPreview();
    });
    box.appendChild(row);
  }
}

// ---------- Montagem da mensagem ----------
// Retorna { phone } quando válido ou { error } com o motivo.
function checkPhone(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { error: 'Telefone vazio' };
  if (/[a-z]/i.test(text)) return { error: 'Contém letras' };
  let d = text.replace(/\D/g, '');
  if (!d) return { error: 'Sem dígitos' };
  const ddi = $('ddi').value.replace(/\D/g, '');
  const hasIntl = /^\s*(\+|00)/.test(text);
  if (hasIntl) d = d.replace(/^00/, '');
  else if (ddi && (d.length === 10 || d.length === 11)) d = ddi + d;

  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = Number(d.slice(2, 4));
    const local = d.slice(4);
    if (ddd < 11 || ddd > 99) return { error: `DDD inválido (${d.slice(2, 4)})` };
    if (local.length === 9 && local[0] !== '9') return { error: 'Celular com 9 dígitos deve começar com 9' };
    if (local.length === 8 && /^[6-9]/.test(local)) return { error: 'Celular sem o dígito 9 após o DDD' };
    if (local.length === 8) return { error: 'Telefone fixo (não tem WhatsApp)' };
    return { phone: d };
  }
  if (d.length < 11) return { error: `Poucos dígitos (${d.length})` };
  if (d.length > 15) return { error: `Dígitos demais (${d.length})` };
  return { phone: d };
}

function buildItem(row) {
  const missing = [];
  const message = $('message').value.replace(VAR_RE, (_, raw) => {
    const name = raw.trim();
    const col = columnFor(name);
    const val = col ? String(row[col] ?? '').trim() : '';
    if (val) return val;
    const def = (state.defaults[norm(name)] || '').trim();
    if (!def) missing.push(name);
    return def;
  });
  const { phone, error } = checkPhone(row[$('phoneCol').value]);
  return { phone, error, message, fields: row, missing };
}

// Classifica todas as linhas em válidas/inválidas (inclui detecção de duplicados).
function analyze() {
  const valid = [], invalid = [];
  const seen = new Map();
  let emptyFields = 0;
  state.rows.forEach((row, i) => {
    const line = i + 2; // linha 1 é o cabeçalho
    const it = buildItem(row);
    let error = it.error;
    if (!error) {
      if (seen.has(it.phone)) error = `Duplicado (mesmo número da linha ${seen.get(it.phone)})`;
      else seen.set(it.phone, line);
    }
    if (error) invalid.push({ line, raw: row[$('phoneCol').value] ?? '', error, row });
    else { valid.push(it); if (it.missing.length) emptyFields++; }
  });
  return { valid, invalid, emptyFields };
}

function renderPreview() {
  renderVars(false);
  const n = state.rows.length;
  if (!n || !$('message').value.trim()) {
    $('preview').textContent = 'Carregue o CSV e escreva a mensagem.';
    $('previewPos').textContent = '—';
    $('previewPhone').textContent = '';
    $('stats').textContent = '';
    $('invalidBox').hidden = true;
    return;
  }
  state.previewIdx = Math.min(Math.max(state.previewIdx, 0), n - 1);
  const item = buildItem(state.rows[state.previewIdx]);
  $('previewPos').textContent = `Contato ${state.previewIdx + 1} de ${n}`;
  $('previewPhone').textContent = item.phone ? `Para: +${item.phone}` : `⚠ ${item.error}`;
  $('preview').textContent = item.message;

  const { valid, invalid, emptyFields } = analyze();
  state.invalid = invalid;
  $('stats').textContent =
    `${valid.length} contatos válidos · ${invalid.length} inválidos (não serão enviados)` +
    (emptyFields ? ` · ${emptyFields} com campo vazio sem valor padrão` : '');
  $('invalidBox').hidden = !invalid.length;
  $('invalidSummary').textContent = `${invalid.length} números inválidos — ver detalhes`;
  $('invalidTable').querySelector('tbody').innerHTML = invalid.slice(0, 500).map((r) =>
    `<tr><td>${r.line}</td><td>${esc(r.raw)}</td><td class="err-text">${esc(r.error)}</td></tr>`).join('') +
    (invalid.length > 500 ? `<tr><td colspan="3" class="muted">… e mais ${invalid.length - 500} (baixe o CSV)</td></tr>` : '');
}

$('downloadInvalid').addEventListener('click', () => {
  const rows = (state.invalid || []).map((r) => ({ linha_csv: r.line, ...r.row, erro_telefone: r.error }));
  const blob = new Blob(['﻿' + Papa.unparse(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'telefones_invalidos.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- Janela de envio ----------
const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const savedDays = (() => { try { return JSON.parse(localStorage.getItem('disp_days')); } catch { return null; } })() || [1, 2, 3, 4, 5];
$('days').innerHTML = DAY_NAMES.map((n, i) =>
  `<label><input type="checkbox" value="${i}" ${savedDays.includes(i) ? 'checked' : ''}> ${n}</label>`).join('');
$('days').addEventListener('change', () => {
  const sel = [...$('days').querySelectorAll('input:checked')].map((i) => Number(i.value));
  localStorage.setItem('disp_days', JSON.stringify(sel));
});
const savedWin = localStorage.getItem('disp_windowEnabled');
if (savedWin !== null) $('windowEnabled').checked = savedWin === '1';
$('windowEnabled').addEventListener('change', () => {
  localStorage.setItem('disp_windowEnabled', $('windowEnabled').checked ? '1' : '0');
  $('windowConfig').hidden = !$('windowEnabled').checked;
});
$('windowConfig').hidden = !$('windowEnabled').checked;

const brFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
setInterval(() => { $('brClock').textContent = brFmt.format(new Date()); }, 1000);
$('brClock').textContent = brFmt.format(new Date());

$('message').addEventListener('input', renderPreview);
$('phoneCol').addEventListener('change', renderPreview);
$('ddi').addEventListener('input', renderPreview);
$('prev').addEventListener('click', () => { state.previewIdx--; renderPreview(); });
$('next').addEventListener('click', () => { state.previewIdx++; renderPreview(); });

// ---------- Envio ----------
function config() {
  return {
    webhookUrl: $('webhookUrl').value.trim(),
    headerName: $('headerName').value.trim(),
    headerValue: $('headerValue').value,
    minDelay: Number($('minDelay').value),
    maxDelay: Number($('maxDelay').value),
    batchSize: Number($('batchSize').value),
    batchPause: Number($('batchPause').value),
    windowEnabled: $('windowEnabled').checked,
    windowStart: $('windowStart').value,
    windowEnd: $('windowEnd').value,
    days: [...$('days').querySelectorAll('input:checked')].map((i) => Number(i.value)),
  };
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Sessão expirada'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function validItems() {
  return analyze().valid.map(({ phone, message, fields }) => ({ phone, message, fields }));
}

$('testBtn').addEventListener('click', async () => {
  const items = validItems();
  if (!items.length) return alert('Nenhum contato válido.');
  $('testResult').textContent = 'Enviando…';
  try {
    const r = await api('/api/test', { ...config(), item: items[0] });
    $('testResult').textContent = r.ok ? `✔ Webhook respondeu ${r.status}` : `✖ Falhou (${r.status}): ${r.body}`;
  } catch (e) { $('testResult').textContent = '✖ ' + e.message; }
});

$('startBtn').addEventListener('click', async () => {
  const items = validItems();
  if (!items.length) return alert('Nenhum contato válido.');
  if (!confirm(`Disparar ${items.length} mensagens agora?`)) return;
  try {
    const c = await api('/api/campaigns', { ...config(), items });
    state.campaignId = c.id;
    $('progressCard').hidden = false;
    poll();
  } catch (e) { alert(e.message); }
});

for (const [id, action] of [['pauseBtn', 'pause'], ['resumeBtn', 'resume'], ['cancelBtn', 'cancel']]) {
  $(id).addEventListener('click', async () => {
    if (action === 'cancel' && !confirm('Cancelar o disparo?')) return;
    await api(`/api/campaigns/${state.campaignId}/${action}`);
    poll();
  });
}

async function poll() {
  clearTimeout(state.timer);
  const res = await fetch('/api/campaigns/' + state.campaignId);
  if (!res.ok) return;
  const c = await res.json();
  const done = c.sent + c.failed;
  $('barFill').style.width = (done / c.total * 100) + '%';
  const labels = { running: 'Enviando', paused: 'Pausado', canceled: 'Cancelado', done: 'Concluído', error: 'Erro' };
  let txt = `${labels[c.status] || c.status}: ${done}/${c.total} · ${c.sent} ok · ${c.failed} falhas`;
  if (c.status === 'running' && c.waitingWindow) txt += ' · aguardando janela de envio (horário de Brasília)';
  else if (c.status === 'running' && c.nextAt) txt += ` · próximo em ${Math.max(0, Math.round((c.nextAt - Date.now()) / 1000))}s`;
  $('progressText').textContent = txt;
  $('pauseBtn').hidden = c.status !== 'running';
  $('resumeBtn').hidden = c.status !== 'paused';
  $('cancelBtn').hidden = !['running', 'paused'].includes(c.status);
  $('log').querySelector('tbody').innerHTML = c.log.slice().reverse().map((l) =>
    `<tr><td>${l.index}</td><td>${esc(l.phone || '')}</td>` +
    `<td class="${l.ok ? 'ok-text' : 'err-text'}">${l.ok ? 'enviado' : 'falha ' + l.status}</td><td>${esc(l.info || '')}</td></tr>`
  ).join('');
  if (['running', 'paused'].includes(c.status)) state.timer = setTimeout(poll, 1500);
}

document.getElementById('logout')?.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

// Retoma o acompanhamento se houver campanha ativa ao reabrir a página
fetch('/api/campaigns').then((r) => r.json()).then((list) => {
  const active = list.find((c) => ['running', 'paused'].includes(c.status));
  if (active) { state.campaignId = active.id; $('progressCard').hidden = false; poll(); }
}).catch(() => {});
