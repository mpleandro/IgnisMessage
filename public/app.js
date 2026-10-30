const $ = (id) => document.getElementById(id);
const state = { csvRows: [], manual: [], headers: [], defaults: {}, varKey: '', previewIdx: 0, campaignId: null, timer: null, media: null };

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// ---------- Persistência local das configurações ----------
for (const id of ['minDelay', 'maxDelay', 'batchSize', 'batchPause', 'ddi', 'windowStart', 'windowEnd']) {
  const saved = localStorage.getItem('disp_' + id);
  if (saved !== null) $(id).value = saved;
  $(id).addEventListener('input', () => localStorage.setItem('disp_' + id, $(id).value));
}

// ---------- CSV ----------
function loadCsv(rows, headers, name, restored) {
  state.csvRows = rows;
  state.headers = headers;
  state.csvName = name;
  $('csvInfo').textContent = `${restored ? name + ' (restaurado) · ' : ''}${rows.length} linhas · colunas: ${headers.join(', ')}`;
  $('phoneCol').innerHTML = headers.map((h) => `<option>${esc(h)}</option>`).join('');
  if (!restored) {
    const guess = headers.find((h) => /(whats|telefone|celular|phone|fone|numero|número)/i.test(h));
    if (guess) $('phoneCol').value = guess;
  }
  $('phoneConfig').hidden = false;
  state.previewIdx = 0;
  renderCsvTable();
  renderVars(true);
  renderPreview();
}

$('csvFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
    complete: (res) => {
      loadCsv(res.data, res.meta.fields || [], file.name, false);
      state.csvDirty = true;
      scheduleSave();
    },
    error: (err) => alert('Erro ao ler CSV: ' + err.message),
  });
});

// Tabela com as primeiras linhas do CSV; clicar no cabeçalho insere {{coluna}} na mensagem.
function renderCsvTable() {
  const sample = state.csvRows.slice(0, 5);
  $('csvPreview').hidden = !state.headers.length;
  $('csvPreviewInfo').textContent =
    `Primeiras ${sample.length} de ${state.csvRows.length} linhas. Clique no nome de uma coluna para inserir {{coluna}} na mensagem.`;
  $('csvTable').innerHTML =
    '<thead><tr>' + state.headers.map((h) => `<th title="Inserir {{${esc(h)}}}" data-col="${esc(h)}">${esc(h)}</th>`).join('') + '</tr></thead>' +
    '<tbody>' + sample.map((r) => '<tr>' + state.headers.map((h) => `<td title="${esc(r[h] ?? '')}">${esc(r[h] ?? '')}</td>`).join('') + '</tr>').join('') + '</tbody>';
}

$('csvTable').addEventListener('click', (e) => {
  const col = e.target.dataset && e.target.dataset.col;
  if (!col) return;
  const ta = $('message');
  const tag = `{{${col}}}`;
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, a) + tag + ta.value.slice(b);
  ta.focus();
  ta.setSelectionRange(a + tag.length, a + tag.length);
  renderPreview();
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

// ---------- Anexo (imagem / vídeo / documento) ----------
const MEDIA_MAX = 50 * 1024 * 1024;
const MEDIA_ICON = { image: '🖼', video: '🎬', document: '📄' };
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

function renderMedia() {
  const m = state.media;
  $('mediaInfo').textContent = m
    ? `${MEDIA_ICON[m.type]} ${m.name} · ${fmtSize(m.size)} · ${{ image: 'imagem', video: 'vídeo', document: 'documento' }[m.type]}`
    : 'Nenhum anexo. Máx. 50 MB.';
  $('mediaRemove').hidden = !m;
  renderPreview();
}

$('mediaFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MEDIA_MAX) return alert('Arquivo maior que 50 MB.');
  $('mediaInfo').textContent = 'Enviando arquivo…';
  try {
    const res = await fetch('/api/media', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        'X-File-Type': file.type || 'application/octet-stream',
      },
      body: file,
    });
    if (res.status === 401) { location.href = '/login'; return; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const old = state.media;
    state.media = data;
    if (old) fetch('/api/media/' + old.id, { method: 'DELETE' });
    renderMedia();
    scheduleSave();
  } catch (err) {
    alert('Erro ao enviar o arquivo: ' + err.message);
    renderMedia();
  }
});

$('mediaRemove').addEventListener('click', () => {
  const old = state.media;
  state.media = null;
  if (old) fetch('/api/media/' + old.id, { method: 'DELETE' });
  renderMedia();
  scheduleSave();
});

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
  const { phone, error } = checkPhone(row[phoneKey()]);
  return { phone, error, message, fields: row, missing };
}

// Coluna que guarda o telefone (no modo só-manual não há CSV, então usa 'telefone').
const phoneKey = () => $('phoneCol').value || 'telefone';

// CSV + números digitados, cada um com sua origem (para mensagens de erro).
function allRows() {
  const key = phoneKey();
  const out = state.csvRows.map((row, i) => ({ row, origin: `linha ${i + 2}` })); // linha 1 é o cabeçalho
  state.manual.forEach((n, i) => out.push({ row: { [key]: n }, origin: `manual ${i + 1}` }));
  return out;
}

function parseManual(text) {
  return text.split(/[\n,;\t]+/).map((t) => t.trim()).filter(Boolean);
}

function updateManualInfo() {
  $('manualInfo').textContent = state.manual.length
    ? `${state.manual.length} número(s) digitado(s), somados ao CSV (se houver). Campos {{variável}} usam o valor padrão nesses contatos.`
    : 'Os números digitados são somados aos do CSV (se houver). Campos {{variável}} usam o valor padrão nesses contatos.';
}

$('manualNumbers').addEventListener('input', () => {
  state.manual = parseManual($('manualNumbers').value);
  state.previewIdx = 0;
  updateManualInfo();
  renderPreview();
});

// Classifica todas as linhas em válidas/inválidas (inclui detecção de duplicados).
function analyze() {
  const valid = [], invalid = [];
  const seen = new Map();
  let emptyFields = 0;
  allRows().forEach(({ row, origin }) => {
    const it = buildItem(row);
    let error = it.error;
    if (!error) {
      if (seen.has(it.phone)) error = `Duplicado (mesmo número de ${seen.get(it.phone)})`;
      else seen.set(it.phone, origin);
    }
    if (error) invalid.push({ line: origin, raw: row[phoneKey()] ?? '', error, row });
    else { valid.push(it); if (it.missing.length) emptyFields++; }
  });
  return { valid, invalid, emptyFields };
}

function renderPreview() {
  renderVars(false);
  const rows = allRows();
  const n = rows.length;
  if (!n || (!$('message').value.trim() && !state.media)) {
    $('preview').textContent = 'Carregue o CSV ou digite números, e escreva a mensagem.';
    $('previewPos').textContent = '—';
    $('previewPhone').textContent = '';
    $('stats').textContent = '';
    $('invalidBox').hidden = true;
    return;
  }
  state.previewIdx = Math.min(Math.max(state.previewIdx, 0), n - 1);
  const item = buildItem(rows[state.previewIdx].row);
  $('previewPos').textContent = `Contato ${state.previewIdx + 1} de ${n}`;
  $('previewPhone').textContent = item.phone ? `Para: +${item.phone}` : `⚠ ${item.error}`;
  const m = state.media;
  $('preview').textContent = (m ? `${MEDIA_ICON[m.type]} ${m.name}\n` : '') + item.message;

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
  const rows = (state.invalid || []).map((r) => ({ origem: r.line, ...r.row, erro_telefone: r.error }));
  const fields = ['origem', ...new Set([...state.headers, phoneKey()]), 'erro_telefone'];
  const blob = new Blob(['﻿' + Papa.unparse({ fields, data: rows })], { type: 'text/csv;charset=utf-8' });
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

// ---------- Destino (configurado em /settings.html) ----------
fetch('/api/settings').then((r) => r.json()).then((s) => {
  const el = $('destInfo');
  state.destReady = s.ready;
  if (!s.ready) { el.textContent = '⚠ Destino não configurado — abra Configurações.'; el.className = 'err-text'; return; }
  el.textContent = s.mode === 'evolution'
    ? `Evolution direto · ${s.evolution.baseUrl} · instância ${s.evolution.instance}`
    : `N8N · ${s.n8n.url}`;
}).catch(() => {});

// ---------- Envio ----------
function config() {
  return {
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
    const r = await api('/api/test', { ...config(), item: items[0], mediaId: state.media && state.media.id });
    $('testResult').textContent = r.ok ? `✔ Destino respondeu ${r.status}` : `✖ Falhou (${r.status}): ${r.body}`;
  } catch (e) { $('testResult').textContent = '✖ ' + e.message; }
});

$('startBtn').addEventListener('click', async () => {
  if (state.destReady === false) return alert('Configure o destino (N8N ou Evolution) em Configurações.');
  const items = validItems();
  if (!items.length) return alert('Nenhum contato válido.');
  if (!$('message').value.trim() && !state.media) return alert('Escreva a mensagem ou anexe um arquivo.');
  if (!confirm(`Disparar ${items.length} mensagens agora?`)) return;
  try {
    const c = await api('/api/campaigns', { ...config(), items, mediaId: state.media && state.media.id });
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

// ---------- Rascunho persistente (salvo no servidor: data/draft.json) ----------
const FORM_IDS = ['message', 'manualNumbers', 'ddi', 'minDelay', 'maxDelay', 'batchSize', 'batchPause', 'windowStart', 'windowEnd'];
let saveTimer = null;
const setSaveState = (t) => { $('saveState').textContent = t; };

function collectForm() {
  const f = {
    defaults: state.defaults,
    phoneCol: $('phoneCol').value,
    media: state.media,
    windowEnabled: $('windowEnabled').checked,
    days: [...$('days').querySelectorAll('input:checked')].map((i) => Number(i.value)),
  };
  for (const id of FORM_IDS) f[id] = $(id).value;
  return f;
}

function scheduleSave() {
  if (state.restoring) return;
  setSaveState('Salvando…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDraft(false), 800);
}

async function saveDraft(keepalive) {
  clearTimeout(saveTimer);
  saveTimer = null;
  const body = { form: collectForm() };
  if (state.csvDirty) body.csv = { name: state.csvName || 'contatos.csv', headers: state.headers, rows: state.csvRows };
  try {
    const r = await fetch('/api/draft', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: keepalive && !body.csv, // keepalive tem limite de 64KB
    });
    if (r.status === 401) { location.href = '/login'; return; }
    if (!r.ok) throw new Error();
    if (body.csv) state.csvDirty = false;
    setSaveState('Rascunho salvo ✓');
  } catch { setSaveState('⚠ Rascunho não salvo'); }
}

document.addEventListener('input', scheduleSave);
document.addEventListener('change', scheduleSave);
window.addEventListener('pagehide', () => { if (saveTimer) saveDraft(true); });

async function restoreDraft() {
  try {
    const r = await fetch('/api/draft');
    if (!r.ok) return;
    const d = await r.json();
    state.restoring = true;
    if (d.csv && Array.isArray(d.csv.headers) && Array.isArray(d.csv.rows)) {
      loadCsv(d.csv.rows, d.csv.headers, d.csv.name || 'contatos.csv', true);
    }
    const f = d.form || {};
    for (const id of FORM_IDS) if (typeof f[id] === 'string') $(id).value = f[id];
    if (f.media && typeof f.media.id === 'string') { state.media = f.media; renderMedia(); }
    if (f.defaults && typeof f.defaults === 'object') state.defaults = f.defaults;
    if (typeof f.windowEnabled === 'boolean') {
      $('windowEnabled').checked = f.windowEnabled;
      $('windowConfig').hidden = !f.windowEnabled;
    }
    if (Array.isArray(f.days)) $('days').querySelectorAll('input').forEach((i) => { i.checked = f.days.includes(Number(i.value)); });
    if (f.phoneCol && state.headers.includes(f.phoneCol)) $('phoneCol').value = f.phoneCol;
    state.manual = parseManual($('manualNumbers').value);
    updateManualInfo();
    renderVars(true);
    renderPreview();
    if (d.savedAt) setSaveState('Rascunho restaurado ✓');
  } catch { /* sem rascunho */ } finally { state.restoring = false; }
}
restoreDraft();

$('clearDraft').addEventListener('click', async () => {
  if (!confirm('Apagar o rascunho salvo (mensagem, CSV, números e campos)?')) return;
  if (state.media) await fetch('/api/media/' + state.media.id, { method: 'DELETE' });
  await fetch('/api/draft', { method: 'DELETE' });
  for (const k of Object.keys(localStorage)) if (k.startsWith('disp_')) localStorage.removeItem(k);
  location.reload();
});
