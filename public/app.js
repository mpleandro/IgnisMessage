const $ = (id) => document.getElementById(id);
const newStep = (text = '') => ({ text, media: null, delayMin: 3, delayMax: 8 });
const state = {
  csvRows: [], manual: [], headers: [], defaults: {}, varKey: '', previewIdx: 0,
  campaignId: null, timer: null, listTimer: null,
  steps: [newStep()], focusStep: 0, uploading: 0,
};

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

// Tabela com as primeiras linhas do CSV; clicar no cabeçalho insere {{coluna}} na mensagem em edição.
function renderCsvTable() {
  const sample = state.csvRows.slice(0, 5);
  $('csvPreview').hidden = !state.headers.length;
  $('csvPreviewInfo').textContent =
    `Primeiras ${sample.length} de ${state.csvRows.length} linhas. Clique no nome de uma coluna para inserir {{coluna}} na mensagem que você está editando.`;
  $('csvTable').innerHTML =
    '<thead><tr>' + state.headers.map((h) => `<th title="Inserir {{${esc(h)}}}" data-col="${esc(h)}">${esc(h)}</th>`).join('') + '</tr></thead>' +
    '<tbody>' + sample.map((r) => '<tr>' + state.headers.map((h) => `<td title="${esc(r[h] ?? '')}">${esc(r[h] ?? '')}</td>`).join('') + '</tr>').join('') + '</tbody>';
}

$('csvTable').addEventListener('click', (e) => {
  const col = e.target.dataset && e.target.dataset.col;
  if (!col) return;
  const j = Math.min(state.focusStep, state.steps.length - 1);
  const ta = $('steps').querySelector(`.step[data-i="${j}"] textarea`);
  if (!ta) return;
  const tag = `{{${col}}}`;
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, a) + tag + ta.value.slice(b);
  state.steps[j].text = ta.value;
  ta.focus();
  ta.setSelectionRange(a + tag.length, a + tag.length);
  renderPreview();
  scheduleSave();
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Sequência de mensagens ----------
const MAX_STEPS = 20;
const MEDIA_MAX = 50 * 1024 * 1024;
const MEDIA_ICON = { image: '🖼', video: '🎬', document: '📄' };
const MEDIA_LABEL = { image: 'imagem', video: 'vídeo', document: 'documento' };
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const hasContent = (s) => !!(s.text.trim() || s.media);
const deleteMediaOnServer = (m) => { if (m) fetch('/api/media/' + m.id, { method: 'DELETE' }).catch(() => {}); };

function renderSteps() {
  const n = state.steps.length;
  $('steps').innerHTML = state.steps.map((s, j) => `
    <div class="step" data-i="${j}">
      <div class="step-head">
        <span class="step-num">Mensagem ${j + 1}</span>
        <div class="step-tools">
          <button type="button" data-act="up" title="Mover para cima" ${j === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-act="down" title="Mover para baixo" ${j === n - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-act="remove" class="danger" title="Remover mensagem" ${n === 1 ? 'disabled' : ''}>✕</button>
        </div>
      </div>
      ${j > 0 ? `
      <div class="row step-delay">
        <label>Aguardar antes desta — mínimo (s) <input type="number" min="0" data-k="delayMin" value="${esc(s.delayMin)}"></label>
        <label>máximo (s) <input type="number" min="0" data-k="delayMax" value="${esc(s.delayMax)}"></label>
      </div>` : ''}
      <textarea rows="${j === 0 ? 5 : 3}" data-k="text" placeholder="${j === 0 ? 'Oi {{nome}}, bom dia!' : 'Como vai?'}">${esc(s.text)}</textarea>
      <div class="step-attach">
        <label class="file-btn">${s.media ? 'Trocar anexo' : '+ Anexo'}<input type="file" data-k="media" hidden
          accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"></label>
        <span class="muted">${s.uploading ? 'Enviando arquivo…' : s.media
          ? `${MEDIA_ICON[s.media.type]} ${esc(s.media.name)} · ${fmtSize(s.media.size)} · ${MEDIA_LABEL[s.media.type]} (o texto vira legenda)`
          : 'Imagem, vídeo ou documento (opcional, máx. 50 MB)'}</span>
        ${s.media ? '<button type="button" data-act="unmedia" class="link-btn">Remover anexo</button>' : ''}
      </div>
    </div>`).join('');
  $('addStep').disabled = n >= MAX_STEPS;
}

const stepIndex = (el) => Number(el.closest('.step').dataset.i);

$('steps').addEventListener('focusin', (e) => {
  if (e.target.matches('textarea')) state.focusStep = stepIndex(e.target);
});

$('steps').addEventListener('input', (e) => {
  const k = e.target.dataset.k;
  if (!k || k === 'media') return;
  const s = state.steps[stepIndex(e.target)];
  s[k] = k === 'text' ? e.target.value : Math.max(0, Number(e.target.value) || 0);
  renderPreview();
});

$('steps').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const j = stepIndex(e.target);
  const steps = state.steps;
  if (act === 'up' && j > 0) [steps[j - 1], steps[j]] = [steps[j], steps[j - 1]];
  else if (act === 'down' && j < steps.length - 1) [steps[j + 1], steps[j]] = [steps[j], steps[j + 1]];
  else if (act === 'remove' && steps.length > 1) {
    if (hasContent(steps[j]) && !confirm(`Remover a mensagem ${j + 1}?`)) return;
    deleteMediaOnServer(steps[j].media);
    steps.splice(j, 1);
  } else if (act === 'unmedia') {
    deleteMediaOnServer(steps[j].media);
    steps[j].media = null;
  } else return;
  state.focusStep = Math.min(state.focusStep, steps.length - 1);
  renderSteps();
  renderPreview();
  scheduleSave();
});

$('steps').addEventListener('change', async (e) => {
  if (e.target.dataset.k !== 'media') return;
  const step = state.steps[stepIndex(e.target)]; // guarda o objeto: continua certo mesmo se a ordem mudar durante o upload
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MEDIA_MAX) return alert('Arquivo maior que 50 MB.');
  step.uploading = true;
  state.uploading++;
  renderSteps();
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
    if (!state.steps.includes(step)) { deleteMediaOnServer(data); return; } // passo removido durante o upload
    deleteMediaOnServer(step.media);
    step.media = data;
    scheduleSave();
  } catch (err) {
    alert('Erro ao enviar o arquivo: ' + err.message);
  } finally {
    delete step.uploading;
    state.uploading--;
    renderSteps();
    renderPreview();
  }
});

$('addStep').addEventListener('click', () => {
  if (state.steps.length >= MAX_STEPS) return;
  const last = state.steps[state.steps.length - 1];
  const s = newStep();
  if (state.steps.length > 1) { s.delayMin = last.delayMin; s.delayMax = last.delayMax; }
  state.steps.push(s);
  state.focusStep = state.steps.length - 1;
  renderSteps();
  $('steps').querySelector(`.step[data-i="${state.focusStep}"] textarea`).focus();
  renderPreview();
  scheduleSave();
});

// Passos com conteúdo (os vazios não são enviados).
const activeSteps = () => state.steps.filter(hasContent);

// ---------- Variáveis ----------
function messageVars() {
  const seen = new Map();
  for (const s of state.steps) {
    for (const m of s.text.matchAll(VAR_RE)) {
      const name = m[1].trim();
      if (!seen.has(norm(name))) seen.set(norm(name), name);
    }
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

// ---------- Montagem das mensagens ----------
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

function fillTemplate(text, row, missing) {
  return text.replace(VAR_RE, (_, raw) => {
    const name = raw.trim();
    const col = columnFor(name);
    const val = col ? String(row[col] ?? '').trim() : '';
    if (val) return val;
    const def = (state.defaults[norm(name)] || '').trim();
    if (!def) missing.add(name);
    return def;
  });
}

// messages[j] corresponde a activeSteps()[j].
function buildItem(row) {
  const missing = new Set();
  const messages = activeSteps().map((s) => fillTemplate(s.text, row, missing));
  const { phone, error } = checkPhone(row[phoneKey()]);
  return { phone, error, messages, fields: row, missing: [...missing] };
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

const fmtDelay = (s) => (s.delayMin >= s.delayMax ? `${s.delayMin}s` : `${s.delayMin}–${s.delayMax}s`);

function renderPreview() {
  renderVars(false);
  const rows = allRows();
  const n = rows.length;
  const steps = activeSteps();
  if (!n || !steps.length) {
    $('preview').innerHTML = '<div class="bubble">Carregue o CSV ou digite números, e escreva a mensagem.</div>';
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
  $('preview').innerHTML = steps.map((s, j) => {
    const text = item.messages[j];
    const empty = !text.trim() && !s.media;
    return (j ? `<div class="wait">⏱ aguarda ${fmtDelay(s)}</div>` : '') +
      `<div class="bubble${empty ? ' empty' : ''}">${s.media ? `${MEDIA_ICON[s.media.type]} ${esc(s.media.name)}\n` : ''}` +
      `${empty ? '(vazia para este contato — não será enviada)' : esc(text)}</div>`;
  }).join('');

  const { valid, invalid, emptyFields } = analyze();
  state.invalid = invalid;
  $('stats').textContent =
    `${valid.length} contatos válidos · ${steps.length} mensagem(ns) por contato · ${invalid.length} inválidos (não serão enviados)` +
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
const brDateFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const fmtBr = (ts) => (ts ? brDateFmt.format(new Date(ts)) : '—');
setInterval(() => { $('brClock').textContent = brFmt.format(new Date()); }, 1000);
$('brClock').textContent = brFmt.format(new Date());

$('phoneCol').addEventListener('change', renderPreview);
$('ddi').addEventListener('input', renderPreview);
$('prev').addEventListener('click', () => { state.previewIdx--; renderPreview(); });
$('next').addEventListener('click', () => { state.previewIdx++; renderPreview(); });

// ---------- Agendamento ----------
// Data/hora em Brasília no formato do input datetime-local (YYYY-MM-DDTHH:MM).
function brasiliaLocal(offsetMin = 0) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(Date.now() + offsetMin * 60000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function updateScheduleUi() {
  const on = $('scheduleEnabled').checked;
  $('scheduleConfig').hidden = !on;
  if (on && (!$('scheduleAt').value || $('scheduleAt').value < brasiliaLocal())) $('scheduleAt').value = brasiliaLocal(60);
  $('scheduleAt').min = brasiliaLocal();
  $('startBtn').textContent = on ? 'Agendar disparo' : 'Iniciar disparo';
}
$('scheduleEnabled').addEventListener('change', updateScheduleUi);

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

function stepsPayload() {
  return activeSteps().map((s) => ({ mediaId: s.media && s.media.id, delayMin: s.delayMin, delayMax: s.delayMax }));
}

function validItems() {
  return analyze().valid.map(({ phone, messages, fields }) => ({ phone, messages, fields }));
}

function checkReady() {
  if (state.uploading > 0) return 'Aguarde o envio dos anexos terminar.';
  if (!activeSteps().length) return 'Escreva ao menos uma mensagem ou anexe um arquivo.';
  if (!validItems().length) return 'Nenhum contato válido.';
  return null;
}

$('testBtn').addEventListener('click', async () => {
  const err = checkReady();
  if (err) return alert(err);
  const n = activeSteps().length;
  $('testResult').textContent = n > 1 ? `Enviando sequência de ${n} mensagens (esperas limitadas a 10s no teste)…` : 'Enviando…';
  try {
    const r = await api('/api/test', { item: validItems()[0], steps: stepsPayload() });
    const okCount = r.results.filter((x) => x.ok).length;
    $('testResult').textContent = r.ok
      ? `✔ ${okCount} mensagem(ns) aceitas pelo destino`
      : `✖ Falhou na mensagem ${r.results.length ? r.results[r.results.length - 1].step : '?'} (${r.status ?? '—'}): ${r.body ?? 'nada enviado'}`;
  } catch (e) { $('testResult').textContent = '✖ ' + e.message; }
});

$('startBtn').addEventListener('click', async () => {
  if (state.destReady === false) return alert('Configure o destino (N8N ou Evolution) em Configurações.');
  const err = checkReady();
  if (err) return alert(err);
  const items = validItems();
  const n = activeSteps().length;
  const scheduled = $('scheduleEnabled').checked;
  const at = $('scheduleAt').value;
  if (scheduled && !at) return alert('Informe a data e hora do agendamento.');
  const what = `${items.length} contatos × ${n} mensagem(ns)`;
  const when = scheduled ? `para ${at.split('T')[0].split('-').reverse().join('/')} às ${at.split('T')[1]} (Brasília)` : 'agora';
  if (!confirm(`${scheduled ? 'Agendar' : 'Disparar'} ${what} ${when}?`)) return;
  try {
    const c = await api('/api/campaigns', { ...config(), items, steps: stepsPayload(), scheduleAt: scheduled ? at : null });
    selectCampaign(c.id);
    refreshCampaigns();
    $('testResult').textContent = scheduled
      ? `✔ Agendado para ${fmtBr(c.startAt)}. Você pode editar as mensagens e agendar outra campanha.`
      : '✔ Disparo iniciado.';
  } catch (e) { alert(e.message); }
});

for (const [id, action] of [['pauseBtn', 'pause'], ['resumeBtn', 'resume'], ['cancelBtn', 'cancel'], ['startNowBtn', 'start']]) {
  $(id).addEventListener('click', () => campaignAction(state.campaignId, action));
}

async function campaignAction(id, action) {
  if (!id) return;
  if (action === 'cancel' && !confirm('Cancelar esta campanha?')) return;
  if (action === 'start' && !confirm('Iniciar esta campanha agora, sem esperar o horário agendado?')) return;
  if (action === 'remove' && !confirm('Remover esta campanha do histórico?')) return;
  try { await api(`/api/campaigns/${id}/${action}`); } catch (e) { alert(e.message); }
  if (action === 'remove' && id === state.campaignId) { state.campaignId = null; $('progressCard').hidden = true; }
  refreshCampaigns();
  if (state.campaignId) poll();
}

const STATUS_LABEL = { scheduled: 'Agendada', running: 'Enviando', paused: 'Pausada', canceled: 'Cancelada', done: 'Concluída', error: 'Erro' };
const ACTIVE = ['scheduled', 'running', 'paused'];

function untilText(ts) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  return `${Math.round(s / 86400)} dia(s)`;
}

function selectCampaign(id) {
  state.campaignId = id;
  $('progressCard').hidden = false;
  poll();
}

async function poll() {
  clearTimeout(state.timer);
  if (!state.campaignId) return;
  const res = await fetch('/api/campaigns/' + state.campaignId);
  if (!res.ok) return;
  const c = await res.json();
  const done = c.sent + c.failed;
  $('barFill').style.width = (done / c.total * 100) + '%';
  $('progressTitle').textContent = c.preview ? `· “${c.preview.slice(0, 40)}${c.preview.length > 40 ? '…' : ''}”` : '';
  let txt = `${STATUS_LABEL[c.status] || c.status}: ${done}/${c.total} contatos · ${c.sent} ok · ${c.failed} falhas · ${c.messagesSent} mensagens enviadas`;
  if (c.status === 'scheduled') txt = `Agendada para ${fmtBr(c.startAt)} (Brasília) · começa em ${untilText(c.startAt)} · ${c.total} contatos × ${c.steps} mensagem(ns)`;
  else if (c.status === 'running' && c.waitingWindow) txt += ' · aguardando janela de envio (horário de Brasília)';
  else if (c.status === 'running' && c.nextAt) txt += ` · próxima em ${untilText(c.nextAt)}`;
  $('progressText').textContent = txt;
  $('startNowBtn').hidden = c.status !== 'scheduled';
  $('pauseBtn').hidden = c.status !== 'running';
  $('resumeBtn').hidden = c.status !== 'paused';
  $('cancelBtn').hidden = !ACTIVE.includes(c.status);
  $('log').querySelector('tbody').innerHTML = c.log.slice().reverse().map((l) =>
    `<tr><td>${l.index}</td><td>${l.step ? `${l.step}/${c.steps}` : '—'}</td><td>${esc(l.phone || '')}</td>` +
    `<td class="${l.ok ? 'ok-text' : 'err-text'}">${l.ok ? 'enviada' : 'falha ' + l.status}</td><td>${esc(l.info || '')}</td></tr>`
  ).join('');
  if (ACTIVE.includes(c.status)) state.timer = setTimeout(poll, c.status === 'scheduled' ? 5000 : 1500);
}

// Lista de campanhas (agendadas, em andamento e histórico recente).
async function refreshCampaigns() {
  clearTimeout(state.listTimer);
  try {
    const r = await fetch('/api/campaigns');
    if (r.status === 401) { location.href = '/login'; return; }
    const list = await r.json();
    $('campaignsCard').hidden = !list.length;
    $('campaignList').querySelector('tbody').innerHTML = list.map((c) => {
      const start = c.status === 'scheduled' ? c.startAt : (c.startedAt || c.createdAt);
      const acts = [`<button type="button" data-id="${c.id}" data-act="view">Ver</button>`];
      if (c.status === 'scheduled') acts.push(`<button type="button" data-id="${c.id}" data-act="start">Iniciar agora</button>`);
      if (ACTIVE.includes(c.status)) acts.push(`<button type="button" data-id="${c.id}" data-act="cancel" class="danger">Cancelar</button>`);
      else acts.push(`<button type="button" data-id="${c.id}" data-act="remove">Remover</button>`);
      return `<tr class="${c.id === state.campaignId ? 'sel' : ''}">
        <td>${fmtBr(start)}${c.status === 'scheduled' ? `<br><span class="muted">em ${untilText(c.startAt)}</span>` : ''}</td>
        <td class="st-${c.status}">${STATUS_LABEL[c.status] || c.status}</td>
        <td>${c.sent + c.failed}/${c.total}${c.failed ? ` <span class="err-text">(${c.failed} falhas)</span>` : ''}</td>
        <td>${c.steps}</td>
        <td class="pv" title="${esc(c.preview)}">${esc(c.preview)}</td>
        <td class="row-acts">${acts.join('')}</td></tr>`;
    }).join('');
    if (list.some((c) => ACTIVE.includes(c.status))) state.listTimer = setTimeout(refreshCampaigns, 5000);
  } catch { /* offline */ }
}

$('campaignList').addEventListener('click', (e) => {
  const { id, act } = e.target.dataset;
  if (!id) return;
  if (act === 'view') { selectCampaign(id); refreshCampaigns(); $('progressCard').scrollIntoView({ behavior: 'smooth' }); }
  else campaignAction(id, act);
});

document.getElementById('logout')?.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

// Ao reabrir a página: lista as campanhas e acompanha a ativa mais relevante (enviando > pausada > próxima agendada).
fetch('/api/campaigns').then((r) => r.json()).then((list) => {
  const active = list.find((c) => c.status === 'running') || list.find((c) => c.status === 'paused') ||
    list.filter((c) => c.status === 'scheduled').sort((a, b) => a.startAt - b.startAt)[0];
  if (active) selectCampaign(active.id);
  refreshCampaigns();
}).catch(() => {});

// ---------- Rascunho persistente (salvo no servidor: draft.json) ----------
const FORM_IDS = ['manualNumbers', 'ddi', 'minDelay', 'maxDelay', 'batchSize', 'batchPause', 'windowStart', 'windowEnd', 'scheduleAt'];
let saveTimer = null;
const setSaveState = (t) => { $('saveState').textContent = t; };

function collectForm() {
  const f = {
    defaults: state.defaults,
    phoneCol: $('phoneCol').value,
    steps: state.steps.map(({ text, media, delayMin, delayMax }) => ({ text, media, delayMin, delayMax })),
    windowEnabled: $('windowEnabled').checked,
    scheduleEnabled: $('scheduleEnabled').checked,
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

function restoreSteps(f) {
  const validMedia = (m) => (m && typeof m.id === 'string' ? m : null);
  if (Array.isArray(f.steps) && f.steps.length) {
    return f.steps.slice(0, MAX_STEPS).map((s) => ({
      text: typeof s.text === 'string' ? s.text : '',
      media: validMedia(s.media),
      delayMin: Math.max(0, Number(s.delayMin) || 0),
      delayMax: Math.max(0, Number(s.delayMax) || 0),
    }));
  }
  // rascunho do formato antigo (mensagem única)
  return [{ ...newStep(typeof f.message === 'string' ? f.message : ''), media: validMedia(f.media) }];
}

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
    state.steps = restoreSteps(f);
    if (f.defaults && typeof f.defaults === 'object') state.defaults = f.defaults;
    if (typeof f.windowEnabled === 'boolean') {
      $('windowEnabled').checked = f.windowEnabled;
      $('windowConfig').hidden = !f.windowEnabled;
    }
    if (typeof f.scheduleEnabled === 'boolean') $('scheduleEnabled').checked = f.scheduleEnabled;
    if (Array.isArray(f.days)) $('days').querySelectorAll('input').forEach((i) => { i.checked = f.days.includes(Number(i.value)); });
    if (f.phoneCol && state.headers.includes(f.phoneCol)) $('phoneCol').value = f.phoneCol;
    state.manual = parseManual($('manualNumbers').value);
    updateManualInfo();
    if (d.savedAt) setSaveState('Rascunho restaurado ✓');
  } catch { /* sem rascunho */ } finally {
    state.restoring = false;
    renderSteps();
    updateScheduleUi();
    renderVars(true);
    renderPreview();
  }
}
renderSteps();
updateScheduleUi();
restoreDraft();

$('clearDraft').addEventListener('click', async () => {
  if (!confirm('Apagar o rascunho salvo (mensagens, CSV, números e campos)?\nCampanhas já agendadas não são afetadas.')) return;
  await Promise.all(state.steps.filter((s) => s.media).map((s) => fetch('/api/media/' + s.media.id, { method: 'DELETE' })));
  await fetch('/api/draft', { method: 'DELETE' });
  for (const k of Object.keys(localStorage)) if (k.startsWith('disp_')) localStorage.removeItem(k);
  location.reload();
});
