/* diffboard design boards: an infinite canvas over one design (data model, process, states,
   assumptions). Every change goes to the server as operations; the server answers with the new
   revision and the page refetches, so agents and people editing at once always see one truth. */
'use strict';

const TABLE_W = 260, HEAD_H = 34, ROW_H = 22, STEP_W = 180, LANE_H = 120, PROCESS_TOP = 900;
const PILL_W = 116, PILL_H = 30, PILL_DX = 160, PILL_DY = 78;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

const S = {
  id: null, data: null, designs: [], preview: null, sel: null, tab: null,
  view: { x: 80, y: 80, s: 0.8 }, fitted: false, tool: 'select',
  layers: JSON.parse(localStorage.getItem('design.layers') || '{"data":true,"process":true,"states":true,"assumptions":true}'),
  drag: null, editing: false, history: null,
};

/* ---------- api ---------- */
async function api(path, init) {
  const res = await fetch(path, init && { ...init, headers: { 'content-type': 'application/json' }, body: init.body && JSON.stringify(init.body) });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}
const D = (p = '') => `api/d/${encodeURIComponent(S.id)}${p}`;
async function ops(list, { quiet } = {}) {
  try { const r = await api(D('/ops'), { method: 'POST', body: { ops: list, author: 'you' } }); await refresh(); return r; }
  catch (e) { if (!quiet) toast(e.message, true); await refresh(); return null; }
}
const op = (o) => ops([o]);

function toast(text, err) {
  const t = h(`<div class="toast ${err ? 'err' : ''}">${esc(text)}</div>`);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 2600);
}

/* ---------- loading ---------- */
async function loadDesigns() {
  try { S.designs = (await api('api/designs')).designs || []; } catch { S.designs = []; }
  renderDock();
}
async function refresh() {
  if (!S.id) return;
  try { S.data = await api(D()); }
  catch (e) { S.data = null; toast(e.message, true); }
  if (S.preview) await loadPreview(S.preview.pid, true);
  if (S.tab === 'history') loadHistory();
  render();
}
async function openDesign(id) {
  S.id = id; S.sel = null; S.preview = null; S.fitted = false; S.history = null; S.tab = null;
  if (hashParams().get('d') !== id) history.replaceState(null, '', `#d=${encodeURIComponent(id)}`);
  await refresh();
  seen();
}
function seen() { if (S.id) api(D('/seen'), { method: 'POST', body: { author: 'you' } }).catch(() => {}); }
async function loadPreview(pid, silent) {
  try {
    const p = await api(D(`/preview?proposal=${encodeURIComponent(pid)}`));
    S.preview = { pid, ...p };
    if (!p.applies && !silent) toast(`${pid} no longer applies: ${p.error}`, true);
  } catch (e) { S.preview = null; if (!silent) toast(e.message, true); }
}
async function loadHistory() {
  try { S.history = (await api(D('/history'))).entries || []; } catch { S.history = []; }
  if (S.tab === 'history' || !S.sel) renderInspector();
}

/* ---------- derived ---------- */
const design = () => S.data?.design;
const findings = () => (S.preview?.findings ?? S.data?.findings) || [];
const shown = () => (S.preview && S.preview.applies ? mergePreview(design(), S.preview.design, S.preview.diff) : design());
const tableH = (t) => HEAD_H + t.columns.length * ROW_H + ROW_H + 4;
const modKind = (d, m) => d.modules.find(x => x.name === m)?.kind || 'module';
const colorOf = (name) => {
  if (name === 'you') return 'var(--accent)';
  let x = 0; for (const c of name) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return ['#9a4fb0', '#2f8f8a', '#c0662c', '#4f8a42', '#b0476b', '#6a6fc0'][x % 6];
};
const versionLabel = (d) => !d.approved ? ['draft', 'c-open'] : d.draft ? [`v${d.approved.version} + changes`, 'c-open'] : [`v${d.approved.version} approved`, 'c-ok'];
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The proposal applied, plus what it removes, each item tagged add / del / chg (or nothing: untouched). */
function mergePreview(before, after, diff) {
  const d = structuredClone(after);
  const tset = (k) => new Set(diff[k].added), rset = (k) => new Set(diff[k].removed), cset = (k) => new Set(diff[k].changed);
  for (const t of d.tables) t._st = tset('tables').has(t.name) ? 'add' : cset('tables').has(t.name) ? 'chg' : '';
  for (const name of rset('tables')) { const t = structuredClone(before.tables.find(x => x.name === name)); t._st = 'del'; d.tables.push(t); }
  const cadd = tset('columns'), cchg = cset('columns');
  for (const t of d.tables) for (const c of t.columns) {
    const k = `${t.name}.${c.name}`;
    if (t._st === 'del') c._st = 'del'; else if (cadd.has(k)) c._st = 'add'; else if (cchg.has(k)) c._st = 'chg';
  }
  for (const k of rset('columns')) {
    const [tn, cn] = k.split('.');
    const t = d.tables.find(x => x.name === tn);
    if (!t || t._st === 'del') continue;
    const bt = before.tables.find(x => x.name === tn); const i = bt.columns.findIndex(c => c.name === cn);
    t.columns.splice(Math.min(i, t.columns.length), 0, { ...bt.columns[i], _st: 'del' });
    if (!t._st) t._st = 'chg';
  }
  for (const t of d.tables) if (!t._st && t.columns.some(c => c._st)) t._st = 'chg';
  for (const s of d.steps) s._st = tset('steps').has(s.id) ? 'add' : cset('steps').has(s.id) ? 'chg' : '';
  for (const id of rset('steps')) d.steps.push({ ...structuredClone(before.steps.find(x => x.id === id)), _st: 'del' });
  for (const a of d.assumptions) a._st = tset('assumptions').has(a.id) ? 'add' : cset('assumptions').has(a.id) ? 'chg' : '';
  for (const id of rset('assumptions')) d.assumptions.push({ ...structuredClone(before.assumptions.find(x => x.id === id)), _st: 'del' });
  for (const m of d.machines) { const k = `${m.table}.${m.column}`; m._st = tset('machines').has(k) ? 'add' : cset('machines').has(k) ? 'chg' : ''; }
  d._preview = true;
  return d;
}

/* ---------- render ---------- */
function render() {
  renderTop(); renderDock(); renderCanvas(); renderInspector(); renderStatus();
}

function renderTop() {
  const d = design();
  $('#dname').textContent = d ? d.name : 'design boards';
  const [label, cls] = d ? versionLabel(d) : ['', ''];
  const vc = $('#vchip'); vc.textContent = label; vc.className = `chip ${cls}`;
  $('#undo').disabled = !S.data?.canUndo;
  for (const b of ['#shareBtn', '#approveBtn', '#exportBtn']) $(b).disabled = !d;
  const db = $('#decideBtn');
  if (d) {
    const open = d.proposals.filter(p => p.status === 'open').length;
    const n = open + d.assumptions.filter(a => a.status === 'question' || a.status === 'open').length + (S.data.findings || []).filter(f => f.level === 'error').length;
    db.hidden = !n; db.textContent = open ? `${open} proposal${open === 1 ? '' : 's'}` : `${n} to decide`; db.classList.toggle('urgent', !!open);
  } else db.hidden = true;
  const pres = $('#pres'); pres.innerHTML = '';
  if (!d) return;
  const active = new Set((S.data.presence || []).map(p => p.name));
  const names = ['you', ...d.participants.map(p => p.name).filter(n => n !== 'you')];
  for (const p of (S.data.presence || [])) if (!names.includes(p.name)) names.push(p.name);
  for (const n of names.slice(0, 6)) {
    const role = d.participants.find(p => p.name === n)?.role;
    pres.appendChild(h(`<span class="av ${n === 'you' || active.has(n) ? '' : 'away'}" title="${esc(n)}${role ? ' · ' + role : ''}${active.has(n) ? ' · here now' : ''}"><i style="background:${colorOf(n)}"></i>${esc(n === 'you' ? 'You' : n)}</span>`));
  }
  if (names.length > 6) pres.appendChild(h(`<span class="av">+${names.length - 6}</span>`));
}

function renderDock() {
  const list = $('#designList'); list.innerHTML = '';
  for (const x of S.designs) {
    const li = h(`<li class="it ${x.id === S.id ? 'on' : ''}"><span class="dot" style="background:${x.id === S.id ? 'var(--accent)' : '#b9b9bd'}"></span><span class="t">${esc(x.name)}</span><span class="n">${x.openProposals ? x.openProposals + ' P · ' : ''}${x.draft ? 'draft' : 'v' + x.version}</span></li>`);
    li.onclick = () => openDesign(x.id);
    list.appendChild(li);
  }
  if (!S.designs.length) list.appendChild(h(`<li class="it"><span class="t faint">no designs yet</span></li>`));

  const d = design();
  const L = [['data', 'Data model', 'var(--accent)', d ? `${d.tables.length} tables` : ''], ['process', 'Process', 'var(--proc)', d ? `${d.steps.length} steps` : ''], ['states', 'States', 'var(--note)', d ? `${d.machines.length}` : ''], ['assumptions', 'Assumptions', '#e3c25b', d ? `${d.assumptions.length}` : '']];
  const layers = $('#layers'); layers.innerHTML = '';
  for (const [k, label, col, n] of L) {
    const el = h(`<label class="it"><input type="checkbox" ${S.layers[k] ? 'checked' : ''}><span class="dot" style="background:${col}"></span><span class="t">${label}</span><span class="n">${n}</span></label>`);
    el.querySelector('input').onchange = (e) => { S.layers[k] = e.target.checked; localStorage.setItem('design.layers', JSON.stringify(S.layers)); renderCanvas(); };
    layers.appendChild(el);
  }

  const dec = $('#decide'); dec.innerHTML = '';
  let count = 0;
  if (d) {
    for (const p of d.proposals.filter(p => p.status === 'open')) { count++; addDecide(dec, 'c-ag', p.id, p.title, { kind: 'proposal', id: p.id }); }
    for (const a of d.assumptions.filter(a => a.status === 'question' || a.status === 'open')) { count++; addDecide(dec, a.status === 'question' ? 'c-no' : 'c-open', a.id, a.text, { kind: 'assumption', id: a.id }); }
    for (const f of (S.data.findings || []).filter(f => f.level === 'error')) { count++; addDecide(dec, 'c-no', '!', f.message, targetSel(f.target)); }
  }
  $('#decideCount').textContent = count || '';
  if (d && !count) dec.appendChild(h(`<li class="it"><span class="t faint">nothing open</span></li>`));

  const people = $('#people'); people.innerHTML = '';
  if (d) {
    const active = new Set((S.data.presence || []).map(p => p.name));
    for (const p of d.participants) people.appendChild(h(`<li class="it" title="${active.has(p.name) ? 'here now' : 'joined ' + new Date(p.joinedAt).toLocaleString()}"><span class="dot round" style="background:${colorOf(p.name)};${active.has(p.name) ? '' : 'opacity:.45'}"></span><span class="t">${esc(p.name)}</span><span class="n">${p.role}</span></li>`));
    if (!d.participants.length) people.appendChild(h(`<li class="it"><span class="t faint">only you</span></li>`));
  }
  $('#fileFoot').innerHTML = S.data ? `Saved locally <span class="faint">· rev ${d.rev}</span><br><code title="${esc(S.data.file)}">${esc(shortPath(S.data.file))}</code>` : 'Design boards live as files in your repo (docs/boards).';
}
const shortPath = (f) => { const i = f.indexOf('/docs/'); const parts = f.split('/'); return i > 0 ? `${parts[parts.length - 4] ? '…/' : ''}${f.slice(f.lastIndexOf('/', i - 1) + 1)}` : parts.slice(-3).join('/'); };
function addDecide(list, cls, tag, text, sel) {
  const li = h(`<li class="it"><span class="chip ${cls}">${esc(tag)}</span><span class="t">${esc(text)}</span></li>`);
  li.onclick = () => select(sel, true);
  list.appendChild(li);
}
function targetSel(target) {
  const [kind, rest] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
  if (kind === 'column') { const [t, c] = rest.split('.'); return { kind: 'table', id: t, column: c }; }
  if (kind === 'machine') return { kind: 'machine', id: rest };
  return { kind, id: rest };
}

function renderStatus() {
  const d = design(), st = $('#status');
  if (!d) { st.innerHTML = `<span>● ${location.host}</span>`; return; }
  const f = S.data.findings || [];
  const err = f.filter(x => x.level === 'error').length, warn = f.filter(x => x.level === 'warn').length;
  const cols = d.tables.reduce((n, t) => n + t.columns.length, 0), rels = d.tables.reduce((n, t) => n + t.columns.filter(c => c.ref).length, 0);
  const last = d.comments.length ? d.comments[d.comments.length - 1] : null;
  st.innerHTML = `<span>● ${esc(location.host)}</span><span>${d.tables.length} tables · ${cols} columns · ${rels} relations</span><span>${d.steps.length} steps · ${d.assumptions.length} assumptions</span><span class="${err ? 'bad' : ''}">rules: ${err} error${err === 1 ? '' : 's'} · ${warn} warning${warn === 1 ? '' : 's'}</span>${last ? `<span class="r">last comment: ${esc(last.author)}, ${fmtTime(last.at)}</span>` : ''}`;
}

/* ---------- canvas ---------- */
const world = $('#world'), cv = $('#cv');
function applyView() {
  const { x, y, s } = S.view;
  world.style.transform = `translate(${x}px,${y}px) scale(${s})`;
  cv.style.backgroundPosition = `${x}px ${y}px`;
  cv.style.backgroundSize = `${22 * s}px ${22 * s}px`;
  $('#zoom').textContent = `${Math.round(s * 100)}%  ·  fit`;
  renderMini();
}

function bounds(d) {
  const r = [];
  if (S.layers.data) for (const t of d.tables) r.push([t.x ?? 0, t.y ?? 0, TABLE_W, tableH(t), 't']);
  if (S.layers.process) { for (const s of d.steps) r.push([s.x ?? 0, s.y ?? 0, STEP_W, 70, 'p']); const pf = processFrame(d); if (pf) r.push([pf.x, pf.y, pf.w, pf.h, 'p']); }
  if (S.layers.states) for (const m of d.machines) { const g = machineGeom(m); r.push([m.x ?? 0, m.y ?? 0, g.w, g.h, 'm']); }
  if (S.layers.assumptions) for (const a of d.assumptions) r.push([a.x ?? 0, a.y ?? 0, 220, 110, 'a']);
  return r;
}
function fit() {
  const d = shown(); if (!d) return;
  const r = bounds(d); if (!r.length) { S.view = { x: 80, y: 80, s: 1 }; applyView(); return; }
  const x0 = Math.min(...r.map(b => b[0])) - 40, y0 = Math.min(...r.map(b => b[1])) - 50;
  const x1 = Math.max(...r.map(b => b[0] + b[2])) + 40, y1 = Math.max(...r.map(b => b[1] + b[3])) + 40;
  const W = cv.clientWidth, H = cv.clientHeight;
  const s = Math.max(0.15, Math.min(1.1, Math.min((W - 80) / (x1 - x0), (H - 40) / (y1 - y0))));
  // a phone cannot show a whole board legibly: start at the top-left at a readable scale instead
  if (isPhone() && s < 0.42) { S.view = { s: 0.42, x: 66 - x0 * 0.42, y: 16 - y0 * 0.42 }; applyView(); return; }
  S.view = { s, x: (W - (x1 - x0) * s) / 2 - x0 * s, y: (H - (y1 - y0) * s) / 2 - y0 * s };
  applyView();
}

function renderMini() {
  const d = shown(), mini = $('#mini');
  mini.querySelectorAll('i').forEach(i => i.remove());
  if (!d) { mini.hidden = true; return; }
  const r = bounds(d); mini.hidden = !r.length; if (!r.length) return;
  const W = cv.clientWidth, H = cv.clientHeight, { x, y, s } = S.view;
  const vx0 = -x / s, vy0 = -y / s, vx1 = vx0 + W / s, vy1 = vy0 + H / s;
  const x0 = Math.min(vx0, ...r.map(b => b[0])), y0 = Math.min(vy0, ...r.map(b => b[1]));
  const x1 = Math.max(vx1, ...r.map(b => b[0] + b[2])), y1 = Math.max(vy1, ...r.map(b => b[1] + b[3]));
  const k = Math.min(172 / (x1 - x0), 102 / (y1 - y0));
  for (const [bx, by, bw, bh, kind] of r) mini.appendChild(h(`<i class="${kind === 't' ? '' : kind}" style="left:${4 + (bx - x0) * k}px;top:${4 + (by - y0) * k}px;width:${Math.max(2, bw * k)}px;height:${Math.max(2, bh * k)}px"></i>`));
  const vp = $('#miniVp');
  Object.assign(vp.style, { left: `${4 + (vx0 - x0) * k}px`, top: `${4 + (vy0 - y0) * k}px`, width: `${(vx1 - vx0) * k}px`, height: `${(vy1 - vy0) * k}px` });
  mini.onclick = (e) => {
    const rect = mini.getBoundingClientRect();
    const wx = x0 + (e.clientX - rect.left - 4) / k, wy = y0 + (e.clientY - rect.top - 4) / k;
    S.view.x = W / 2 - wx * S.view.s; S.view.y = H / 2 - wy * S.view.s; applyView();
  };
}

function processFrame(d) {
  if (!d.steps.length && !d.lanes.length) return null;
  const xs = d.steps.map(s => s.x ?? 160);
  const x = Math.min(0, ...xs.map(v => v - 160));
  const right = Math.max(x + 700, ...xs.map(v => v + STEP_W + 40));
  const lanes = Math.max(1, d.lanes.length);
  const bottom = Math.max(PROCESS_TOP + lanes * LANE_H, ...d.steps.map(s => (s.y ?? PROCESS_TOP) + 96));
  return { x, y: PROCESS_TOP - 14, w: right - x, h: bottom - PROCESS_TOP + 24 };
}
function machineGeom(m) {
  const per = Math.min(3, m.states.length);
  const rows = Math.ceil(m.states.length / per);
  const pos = new Map(m.states.map((s, i) => [s, { x: 24 + (i % per) * PILL_DX, y: 34 + Math.floor(i / per) * PILL_DY }]));
  return { pos, w: 48 + (per - 1) * PILL_DX + PILL_W, h: 58 + (rows - 1) * PILL_DY + PILL_H };
}

function renderCanvas() {
  const d = shown();
  world.innerHTML = '';
  $('#empty').hidden = !!d;
  $('#tool').style.display = d ? '' : 'none';
  if (!d) { renderEmpty(); renderMini(); return; }
  const F = findings();
  const badCols = new Set(F.filter(f => f.target.startsWith('column:') && (f.rule === 'module-boundary' || f.rule === 'reference')).map(f => f.target.slice(7)));
  const errSteps = new Set(F.filter(f => f.level === 'error' && f.target.startsWith('step:')).map(f => f.target.slice(5)));
  const pv = !!d._preview;
  const dimCls = (st) => (pv && !st ? 'dim' : st || '');
  const selStep = S.sel?.kind === 'step' ? d.steps.find(s => s.id === S.sel.id) : null;
  const touched = new Map((selStep?.touches || []).map(t => [t.table, t]));

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'wires'); svg.setAttribute('width', '10'); svg.setAttribute('height', '10');
  svg.innerHTML = `<defs>
    <marker id="ahp" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#5fa8a3"/></marker>
    <marker id="ahs" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#b39448"/></marker></defs>`;
  world.appendChild(svg);
  const path = (dAttr, attrs) => { const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', dAttr); p.setAttribute('fill', 'none'); for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v); svg.appendChild(p); return p; };
  const label = (x, y, t, fill = 'var(--faint)', weight = '400') => { const e = document.createElementNS(svg.namespaceURI, 'text'); e.setAttribute('x', x); e.setAttribute('y', y); e.setAttribute('font-size', '10.5'); e.setAttribute('fill', fill); e.setAttribute('font-weight', weight); e.setAttribute('font-family', 'var(--sans)'); e.textContent = t; svg.appendChild(e); };

  /* data model */
  if (S.layers.data) {
    const mods = new Map();
    for (const t of d.tables) if (t.module) { if (!mods.has(t.module)) mods.set(t.module, []); mods.get(t.module).push(t); }
    for (const [m, ts] of mods) {
      const x0 = Math.min(...ts.map(t => t.x)) - 28, y0 = Math.min(...ts.map(t => t.y)) - 34;
      const x1 = Math.max(...ts.map(t => t.x + TABLE_W)) + 28, y1 = Math.max(...ts.map(t => t.y + tableH(t))) + 24;
      const kind = modKind(d, m), def = d.modules.find(x => x.name === m);
      world.appendChild(h(`<div class="frame ${kind === 'platform' ? 'plat' : ''}" style="left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px"><span class="ft">▣ ${kind === 'platform' ? 'platform' : 'module'} <code>${esc(m)}</code>${def?.path ? ` <span class="chip c-mod">${esc(def.path)}</span>` : ''}</span></div>`));
    }
    const pos = new Map(d.tables.map(t => [t.name, t]));
    const rowY = (t, c) => t.y + HEAD_H + Math.max(0, t.columns.findIndex(x => x.name === c)) * ROW_H + ROW_H / 2;
    for (const t of d.tables) for (const c of t.columns) {
      if (!c.ref || !pos.has(c.ref.table)) continue;
      const p = pos.get(c.ref.table);
      if (!p.columns.some(x => x.name === c.ref.column)) continue;
      const bad = badCols.has(`${t.name}.${c.name}`);
      const st = c._st || (t._st === 'del' ? 'del' : '');
      const color = bad ? 'var(--del)' : st === 'add' ? 'var(--add)' : st === 'del' ? 'var(--del)' : '#9aa0ad';
      const ay = rowY(t, c.name), by = rowY(p, c.ref.column);
      let ax, bx, da, db;
      if (t.x + TABLE_W < p.x) { ax = t.x + TABLE_W; bx = p.x; da = 1; db = -1; }
      else if (p.x + TABLE_W < t.x) { ax = t.x; bx = p.x + TABLE_W; da = -1; db = 1; }
      else { ax = t.x; bx = p.x; da = -1; db = -1; }
      const k = Math.max(40, Math.abs(bx - ax) / 2);
      const w = path(`M${ax},${ay} C${ax + da * k},${ay} ${bx + db * k},${by} ${bx},${by}`, { stroke: color, 'stroke-width': bad ? 1.8 : 1.4, ...(c.fk === false || bad ? { 'stroke-dasharray': '5 4' } : {}) });
      if (pv && !st && !t._st && !p._st) w.setAttribute('opacity', '.3');
      // crow's foot on the many side (the referencing column), a bar on the one side
      path(`M${ax + da * 11},${ay} L${ax},${ay - 5} M${ax + da * 11},${ay} L${ax},${ay + 5} M${ax + da * 11},${ay} L${ax},${ay}`, { stroke: color, 'stroke-width': 1.4 });
      path(`M${bx + db * 6},${by - 5} L${bx + db * 6},${by + 5}`, { stroke: color, 'stroke-width': 1.4 });
    }
    for (const t of d.tables) world.appendChild(tableCard(d, t, { dim: dimCls(t._st), badCols, touch: touched.get(t.name), dimmed: !!selStep && !touched.has(t.name) }));
  }

  /* process */
  if (S.layers.process) {
    const pf = processFrame(d);
    if (pf) {
      world.appendChild(h(`<div class="frame proc" style="left:${pf.x}px;top:${pf.y}px;width:${pf.w}px;height:${pf.h}px"><span class="ft">⇢ process</span></div>`));
      d.lanes.forEach((l, i) => world.appendChild(h(`<div class="lane" style="left:${pf.x}px;width:${pf.w}px;top:${PROCESS_TOP + i * LANE_H}px;${i ? '' : 'border-top:0'}">${esc(l)}</div>`)));
      const sp = new Map(d.steps.map(s => [s.id, s]));
      for (const f of d.flows) {
        const a = sp.get(f.from), b = sp.get(f.to); if (!a || !b) continue;
        const forward = a.x + STEP_W <= b.x;
        const x1 = forward ? a.x + STEP_W : a.x + STEP_W / 2, y1 = forward ? a.y + 30 : a.y + (b.y > a.y ? 70 : 0);
        const x2 = forward ? b.x : b.x + STEP_W / 2, y2 = forward ? b.y + 30 : b.y + (b.y > a.y ? 0 : 70);
        const dAttr = forward ? `M${x1},${y1} C${x1 + 34},${y1} ${x2 - 34},${y2} ${x2 - 3},${y2}` : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
        const p = path(dAttr, { stroke: '#5fa8a3', 'stroke-width': 1.5, 'marker-end': 'url(#ahp)' });
        if (pv) p.setAttribute('opacity', '.35');
        if (f.label) label((x1 + x2) / 2 - f.label.length * 2.6, (y1 + y2) / 2 - 6, f.label);
      }
      const tables = new Set(d.tables.map(t => t.name));
      for (const s of d.steps) world.appendChild(stepCard(s, { tables, err: errSteps.has(s.id), dim: dimCls(s._st) }));
    }
  }

  /* state machines */
  if (S.layers.states) for (const m of d.machines) {
    const g = machineGeom(m), key = `${m.table}.${m.column}`;
    const unreach = new Set(F.filter(f => f.target === `machine:${key}` && f.message.includes('cannot be reached')).map(f => /“([^”]+)”/.exec(f.message)?.[1]));
    const fr = h(`<div class="mach ${S.sel?.kind === 'machine' && S.sel.id === key ? 'sel' : ''} ${dimCls(m._st)}" data-kind="machine" data-id="${esc(key)}" style="left:${m.x}px;top:${m.y}px;width:${g.w}px;height:${g.h}px"><span class="ft" data-drag="1">◎ states: ${esc(key)}</span></div>`);
    m.states.forEach((st, i) => { const p = g.pos.get(st); fr.appendChild(h(`<div class="pill ${i === 0 ? 'first' : ''} ${unreach.has(st) ? 'unreach' : ''}" style="left:${p.x}px;top:${p.y}px" title="${esc(st)}">${esc(st)}</div>`)); });
    world.appendChild(fr);
    const pairs = new Set(m.transitions.map(t => `${t.from}>${t.to}`));
    for (const t of m.transitions) {
      const a = g.pos.get(t.from), b = g.pos.get(t.to); if (!a || !b) continue;
      const ax = m.x + a.x + PILL_W / 2, ay = m.y + a.y + PILL_H / 2, bx = m.x + b.x + PILL_W / 2, by = m.y + b.y + PILL_H / 2;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const off = pairs.has(`${t.to}>${t.from}`) ? 6 : 0;
      const ox = -uy * off, oy = ux * off;
      const clip = (vx, vy) => Math.min(Math.abs((PILL_W / 2 + 3) / (vx || 1e-9)), Math.abs((PILL_H / 2 + 3) / (vy || 1e-9)));
      const c = clip(ux, uy);
      const sx = ax + ux * c + ox, sy = ay + uy * c + oy, ex = bx - ux * c + ox, ey = by - uy * c + oy;
      const sel = S.sel?.kind === 'step' && t.step === S.sel.id;
      path(`M${sx},${sy} L${ex},${ey}`, { stroke: sel ? 'var(--accent)' : '#b39448', 'stroke-width': sel ? 2 : 1.4, 'marker-end': 'url(#ahs)' });
      if (t.step || t.label) label((sx + ex) / 2 + 5 + ox, (sy + ey) / 2 - 4 + oy, [t.step, t.label].filter(Boolean).join(' · '), sel ? 'var(--accent)' : 'var(--faint)', sel ? '600' : '400');
    }
  }

  /* assumptions */
  if (S.layers.assumptions && d.assumptions.length) {
    const xs = d.assumptions.map(a => a.x ?? 0), ys = d.assumptions.map(a => a.y ?? 0);
    const x0 = Math.min(...xs) - 20, y0 = Math.min(...ys) - 28, x1 = Math.max(...xs) + 240, y1 = Math.max(...ys) + 130;
    world.appendChild(h(`<div class="frame asm" style="left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px"><span class="ft">✦ assumptions and questions</span></div>`));
    for (const a of d.assumptions) world.appendChild(sticky(a, dimCls(a._st)));
  }
  applyView();
}

function tableCard(d, t, { dim, badCols, touch, dimmed }) {
  const sel = S.sel?.kind === 'table' && S.sel.id === t.name;
  const kind = t.module ? modKind(d, t.module) : null;
  const el = h(`<div class="tbl ${t.kind === 'view' ? 'view' : ''} ${sel ? 'sel' : ''} ${dim} ${dimmed ? 'dim' : ''}" data-kind="table" data-id="${esc(t.name)}" style="left:${t.x}px;top:${t.y}px">
    <div class="th" data-drag="1"><b>${esc(t.name)}</b>${t.kind === 'view' ? '<span class="chip c-ok">view</span>' : ''}${t.module ? `<span class="chip ${kind === 'platform' ? 'c-plat' : 'c-mod'}">${esc(t.module)}</span>` : ''}<span class="cnt">${t.columns.length}</span></div></div>`);
  const hlCols = new Set(touch?.columns || []);
  const hlCol = sel ? S.sel.column : null;
  for (const c of t.columns) {
    const k = c.pk ? 'PK' : c.ref ? 'FK' : '';
    const cls = [c._st || '', badCols.has(`${t.name}.${c.name}`) ? 'bad' : '', hlCols.has(c.name) || hlCol === c.name ? 'hl' : ''].join(' ');
    const row = h(`<div class="row ${cls}" data-col="${esc(c.name)}" title="${esc([c.note, c.ref ? `→ ${c.ref.table}.${c.ref.column}${c.fk === false ? ' (no constraint)' : ''}` : '', c.default ? `default ${c.default}` : ''].filter(Boolean).join(' · '))}"><span class="k ${k.toLowerCase()}">${k}</span><span class="cn" data-edit="name">${esc(c.name)}</span><span class="ty" data-edit="type">${esc(c.type)}</span><span class="nn ${c.nullable ? 'no' : ''}"></span></div>`);
    el.appendChild(row);
  }
  if (!t._st && !d._preview) el.appendChild(h(`<div class="row addc" data-addcol="1"><span class="k"></span>+ column</div>`));
  else el.appendChild(h(`<div class="row"></div>`));
  if (touch) el.appendChild(h(`<span class="crud">${touch.op}</span>`));
  return el;
}

function stepCard(s, { tables, err, dim }) {
  const sel = S.sel?.kind === 'step' && S.sel.id === s.id;
  const io = s.touches.map(t => `<span class="${tables.has(t.table) ? '' : 'miss'}" title="${esc((t.columns || []).join(', '))}">${t.op} ${esc(t.table)}</span>`).join('');
  return h(`<div class="step ${sel ? 'sel' : ''} ${err ? 'gap' : ''} ${dim}" data-kind="step" data-id="${esc(s.id)}" data-drag="1" style="left:${s.x}px;top:${s.y}px"><small><span>${esc(s.id)}</span>${s.trigger ? `<span>· ${esc(s.trigger)}</span>` : ''}</small><div class="st">${esc(s.title)}</div><div class="io">${io}</div></div>`);
}

const STATUS = { accepted: ['accepted', 'c-ok'], open: ['to decide', 'c-open'], question: ['question', 'c-no'], rejected: ['rejected', 'c-plat'] };
const NEXT_STATUS = { open: 'accepted', accepted: 'rejected', rejected: 'question', question: 'open' };
function sticky(a, dim) {
  const sel = S.sel?.kind === 'assumption' && S.sel.id === a.id;
  const [lab, cls] = STATUS[a.status] || STATUS.open;
  return h(`<div class="sticky ${a.status === 'question' ? 'q' : ''} ${a.status === 'rejected' ? 'rej' : ''} ${sel ? 'sel' : ''} ${dim}" data-kind="assumption" data-id="${esc(a.id)}" data-drag="1" style="left:${a.x}px;top:${a.y}px"><div class="h"><b>${esc(a.id)}</b><span class="chip ${cls}" data-cycle="1" title="Click to change">${lab}</span></div><div class="tx">${esc(a.text)}</div>${a.author ? `<div class="by">${esc(a.author)}</div>` : ''}</div>`);
}

function renderEmpty() {
  $('#empty').innerHTML = `<div><h2>${S.designs.length ? 'Pick a design on the left' : 'No design boards yet'}</h2>
  <p class="muted">A design board holds the data model, the process and the assumptions of a solution, agreed on before any code is written. It is a file in your repo (<code>docs/boards/&lt;id&gt;.board.json</code>), so it travels with the branch.</p>
  <p class="muted">An agent session creates one with:</p>
  <pre>diffboard design new "Room booking" ~/code/my-app</pre>
  <p class="faint">Then it adds tables, steps and assumptions with <code>diffboard design op …</code> and sends bigger changes as proposals for you to accept here.</p></div>`;
}

/* ---------- interaction on the canvas ---------- */
const toWorld = (cx, cy) => { const r = cv.getBoundingClientRect(); return { x: (cx - r.left - S.view.x) / S.view.s, y: (cy - r.top - S.view.y) / S.view.s }; };
let spaceDown = false;

cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const s = Math.max(0.1, Math.min(3, S.view.s * Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002))));
    S.view.x = mx - (mx - S.view.x) * (s / S.view.s); S.view.y = my - (my - S.view.y) * (s / S.view.s); S.view.s = s;
  } else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; }
  applyView();
}, { passive: false });

/* Pointers: one finger or the mouse pans empty canvas; two fingers pinch-zoom; a card moves when
   dragged by its handle with the mouse, or after a long press on touch, so scrolling never moves cards. */
const pointers = new Map();
let pinch = null;
const LONG_PRESS = 380;
cv.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  if (e.target.closest('.tool,.mini,.zoom,.previewbar,.empty,input,textarea,select,button')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { startPinch(); return; }
  if (pointers.size > 2) return;
  const item = e.target.closest('[data-kind]');
  if (S.tool !== 'select') { pointers.delete(e.pointerId); await place(S.tool, toWorld(e.clientX, e.clientY)); return; }
  const touch = e.pointerType === 'touch';
  if (!item || spaceDown || e.button === 1) {
    S.drag = { pan: true, sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y, moved: false, onItem: !!item };
    if (!touch) cv.classList.add('panning');
    return;
  }
  if (e.target.closest('[data-cycle],[data-addcol]')) { S.drag = null; return; }
  const handle = e.target.closest('[data-drag]');
  const kind = item.dataset.kind, id = item.dataset.id;
  const src = design() && kindItem(design(), kind, id);
  const movable = !!src && !S.preview && (touch || !!handle);
  S.drag = { item, kind, id, sx: e.clientX, sy: e.clientY, ox: src?.x ?? 0, oy: src?.y ?? 0, vx: S.view.x, vy: S.view.y, moved: false, touch, canMove: movable && !touch, pan: false };
  if (touch && movable) {
    // a touch on a card pans like the canvas until it is held still long enough to lift the card
    const g = S.drag;
    g.timer = setTimeout(() => { if (S.drag === g && !g.moved) { g.canMove = true; g.lifted = true; g.item.classList.add('lifting'); navigator.vibrate?.(10); } }, LONG_PRESS);
  }
});
function startPinch() {
  if (S.drag?.timer) clearTimeout(S.drag.timer);
  if (S.drag?.lifted) { S.drag.item.classList.remove('lifting'); renderCanvas(); }
  S.drag = null;
  const [a, b] = [...pointers.values()];
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...S.view } };
}
cv.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const r = cv.getBoundingClientRect();
    const s = Math.max(0.1, Math.min(3, pinch.view.s * dist / pinch.d));
    const wx = (pinch.cx - r.left - pinch.view.x) / pinch.view.s, wy = (pinch.cy - r.top - pinch.view.y) / pinch.view.s;
    S.view = { s, x: cx - r.left - wx * s, y: cy - r.top - wy * s };
    applyView(); return;
  }
  const g = S.drag; if (!g) return;
  const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
  if (!g.moved && Math.abs(dx) + Math.abs(dy) > (g.touch ? 8 : 3)) {
    g.moved = true;
    // capture only once it is a drag: capturing on press would retarget click and dblclick to the canvas
    try { cv.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }
  if (g.pan || (g.touch && !g.canMove && g.moved)) {
    if (g.timer) { clearTimeout(g.timer); g.timer = null; }
    if (!g.pan) { g.pan = true; }
    S.view.x = g.vx + dx; S.view.y = g.vy + dy; applyView(); return;
  }
  if (g.canMove && g.moved) { g.item.style.left = `${Math.round(g.ox + dx / S.view.s)}px`; g.item.style.top = `${Math.round(g.oy + dy / S.view.s)}px`; g.item.style.zIndex = 10; }
});
const endPointer = async (e) => {
  pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; return; }
  const g = S.drag; S.drag = null; cv.classList.remove('panning');
  if (!g) return;
  if (g.timer) clearTimeout(g.timer);
  if (e.type === 'pointercancel') { if (g.lifted) renderCanvas(); return; }
  if (g.pan) { if (!g.moved && !g.onItem) select(null); return; }
  if (g.canMove && g.moved) {
    const x = Math.round(g.ox + (e.clientX - g.sx) / S.view.s), y = Math.round(g.oy + (e.clientY - g.sy) / S.view.s);
    const d = design(), src = kindItem(d, g.kind, g.id); if (src) { src.x = x; src.y = y; }
    renderCanvas();
    await ops([{ op: 'move', kind: g.kind, id: g.id, x, y }]);
    return;
  }
  if (g.lifted) g.item.classList.remove('lifting');
  if (!g.moved) {
    const now = Date.now(), key = `${g.kind}:${g.id}`;
    if (lastTap && lastTap.key === key && now - lastTap.at < 450 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 12) {
      lastTap = null; onDouble(document.elementFromPoint(e.clientX, e.clientY)); return;
    }
    lastTap = { key, at: now, x: e.clientX, y: e.clientY };
    const row = e.target.closest?.('.row[data-col]') || document.elementFromPoint(e.clientX, e.clientY)?.closest('.row[data-col]');
    select({ kind: g.kind, id: g.id, ...(row ? { column: row.dataset.col } : {}) });
  }
};
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
function kindItem(d, kind, id) {
  return kind === 'table' ? d.tables.find(t => t.name === id) : kind === 'step' ? d.steps.find(s => s.id === id) : kind === 'assumption' ? d.assumptions.find(a => a.id === id) : d.machines.find(m => `${m.table}.${m.column}` === id);
}

cv.addEventListener('click', (e) => {
  const cyc = e.target.closest('[data-cycle]');
  if (cyc && !S.preview) { const id = cyc.closest('[data-id]').dataset.id; const a = design().assumptions.find(x => x.id === id); op({ op: 'set-assumption', id, status: NEXT_STATUS[a.status] || 'open' }); return; }
  const addc = e.target.closest('[data-addcol]');
  if (addc) { const t = addc.closest('[data-id]').dataset.id; addColumnInline(t); }
});
/* Double click (or double tap): edit in place. Detected by hand, because selecting on the first
   click re-renders the card and the browser then never fires dblclick. */
function onDouble(target) {
  if (S.preview || !target) return;
  const cell = target.closest('[data-edit]');
  if (cell) { const row = cell.closest('.row'); editCell(cell, row.closest('[data-id]').dataset.id, row.dataset.col, cell.dataset.edit); return; }
  const st = target.closest('.sticky');
  if (st) { editSticky(st); return; }
  const step = target.closest('.step');
  if (step) { select({ kind: 'step', id: step.dataset.id }); setTimeout(() => $('#insp [data-f=title]')?.focus(), 0); }
}
let lastTap = null;

function inlineInput(host, value, onCommit) {
  S.editing = true;
  const inp = h(`<input value="${esc(value)}" spellcheck="false">`);
  inp.style.width = `${Math.max(60, host.offsetWidth + 30)}px`;
  host.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true; S.editing = false;
    const v = inp.value.trim();
    if (commit && v && v !== value) await onCommit(v); else renderCanvas();
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());
}
function editCell(cell, table, column, field) {
  inlineInput(cell, cell.textContent, (v) => op({ op: 'set-column', table, column, [field]: v }));
}
function addColumnInline(table) {
  const row = world.querySelector(`.tbl[data-id="${CSS.escape(table)}"] [data-addcol]`);
  if (!row) return;
  const span = h(`<span>name type</span>`); row.innerHTML = '<span class="k"></span>'; row.appendChild(span);
  inlineInput(span, '', async (v) => {
    const [name, ...rest] = v.split(/\s+/);
    await op({ op: 'add-column', table, column: { name, type: rest.join(' ') || 'text' } });
  });
  world.querySelector(`.tbl[data-id="${CSS.escape(table)}"] input`).placeholder = 'name type, e.g. created_at timestamptz';
}
function editSticky(st) {
  const id = st.dataset.id, a = design().assumptions.find(x => x.id === id);
  const tx = st.querySelector('.tx'); S.editing = true;
  const ta = h(`<textarea>${esc(a.text)}</textarea>`); tx.replaceWith(ta); ta.focus();
  let done = false;
  const finish = async (commit) => { if (done) return; done = true; S.editing = false; const v = ta.value.trim(); if (commit && v && v !== a.text) await op({ op: 'set-assumption', id, text: v }); else renderCanvas(); };
  ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) finish(true); if (e.key === 'Escape') finish(false); });
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
}

/* toolbar */
function setTool(t) {
  S.tool = t;
  for (const b of document.querySelectorAll('#tool [data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  cv.classList.toggle('placing', t !== 'select');
}
$('#tool').addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
$('#fitBtn').onclick = fit;
$('#zoom').onclick = fit;

async function place(kind, at) {
  setTool('select');
  const d = design(); if (!d) return;
  const x = Math.round(at.x), y = Math.round(at.y);
  if (kind === 'table') {
    const r = await form('Add table', [['name', 'Name', 'e.g. reservation'], ['module', 'Module', d.modules.map(m => m.name).join(', ') || 'optional'], ['columns', 'Columns', 'id uuid pk, name text']]);
    if (!r?.name) return;
    const columns = (r.columns || 'id uuid pk').split(',').map(s => s.trim()).filter(Boolean).map(s => { const [name, type = 'text', ...fl] = s.split(/\s+/); return { name, type, ...(fl.includes('pk') ? { pk: true } : {}), ...(fl.includes('null') ? { nullable: true } : {}) }; });
    await op({ op: 'add-table', table: r.name, ...(r.module ? { module: r.module } : {}), columns, x, y });
    select({ kind: 'table', id: r.name });
  } else if (kind === 'step') {
    const r = await form('Add process step', [['title', 'Title', 'e.g. Guest pays'], ['lane', 'Lane', d.lanes.join(', ') || 'e.g. Guest'], ['after', 'After step', d.steps.length ? d.steps[d.steps.length - 1].id : 'optional']]);
    if (!r?.title) return;
    const res = await op({ op: 'add-step', title: r.title, ...(r.lane ? { lane: r.lane } : {}), ...(r.after ? { after: r.after } : {}), ...(at.y > PROCESS_TOP - 40 ? { x, y } : {}) });
    if (res) { const s = design().steps[design().steps.length - 1]; if (s) select({ kind: 'step', id: s.id }); }
  } else if (kind === 'assumption') {
    const r = await form('Add assumption', [['text', 'Text', 'What we take as given, or a question to settle', 'area'], ['status', 'Status', 'open', 'select:open,accepted,question']]);
    if (!r?.text) return;
    await op({ op: 'add-assumption', text: r.text, status: r.status || 'open', x, y });
  }
}

/* ---------- selection and inspector ---------- */
function select(sel, reveal) {
  S.sel = sel; S.tab = null;
  setDock(false);
  if (sel) openSheet(sel.kind === 'proposal' && !S.preview ? 'half' : sheetSize()); else if (!S.preview) closeSheet();
  if (sel?.kind === 'proposal') { /* preview stays opt-in */ } else if (S.preview && sel?.kind !== 'proposal') { /* keep preview while browsing it */ }
  renderCanvas(); renderInspector();
  if (sel && (reveal || isPhone())) requestAnimationFrame(() => revealSel(sel, !reveal));
}
function revealSel(sel, onlyIfHidden) {
  const d = shown(); if (!d) return;
  const it = sel.kind === 'machine' ? d.machines.find(m => `${m.table}.${m.column}` === sel.id) : sel.kind === 'proposal' ? null : kindItem(d, sel.kind, sel.id);
  if (!it || it.x === undefined) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  const Hv = isPhone() && document.body.classList.contains('sheet-open') ? H - $('#insp').offsetHeight : H;
  if (isPhone()) {
    const s = Math.max(S.view.s, 0.75);
    const sx = it.x * s + (S.view.x / S.view.s) * s, sy = it.y * S.view.s + S.view.y;
    void sx;
    if (onlyIfHidden && S.view.s >= 0.6 && sy > 50 && sy + 80 < Hv) return;
    S.view.s = s; S.view.x = 66 - it.x * s; S.view.y = 64 - it.y * s;
    applyView(); return;
  }
  S.view.x = W / 2 - (it.x + 120) * S.view.s; S.view.y = Math.max(60, Hv / 2) - (it.y + 30) * S.view.s;
  applyView();
}

function renderInspector() {
  const el = $('#insp'); const d = design();
  if (!d) { el.innerHTML = ''; return; }
  const sel = S.sel;
  let tabs, body;
  if (sel?.kind === 'table' && d.tables.some(t => t.name === sel.id)) [tabs, body] = inspTable(d, sel);
  else if (sel?.kind === 'step' && d.steps.some(s => s.id === sel.id)) [tabs, body] = inspStep(d, sel);
  else if (sel?.kind === 'assumption' && d.assumptions.some(a => a.id === sel.id)) [tabs, body] = inspAssumption(d, sel);
  else if (sel?.kind === 'machine' && d.machines.some(m => `${m.table}.${m.column}` === sel.id)) [tabs, body] = inspMachine(d, sel);
  else if (sel?.kind === 'proposal' && d.proposals.some(p => p.id === sel.id)) [tabs, body] = inspProposal(d, sel);
  else [tabs, body] = inspBoard(d);
  el.innerHTML = '';
  const grab = h(`<div class="grabber" title="Bigger / smaller"></div>`);
  grab.onclick = () => openSheet(document.body.classList.contains('sheet-full') ? 'half' : 'full');
  el.appendChild(grab);
  const tb = h(`<div class="tabs"></div>`);
  for (const [k, label] of tabs) {
    const b = h(`<button class="${(S.tab || tabs[0][0]) === k ? 'on' : ''}">${esc(label)}</button>`);
    b.onclick = () => { S.tab = k; if (k === 'history') loadHistory(); renderInspector(); };
    tb.appendChild(b);
  }
  if (sel || isPhone()) { const x = h(`<button class="x" title="Close (Esc)">✕</button>`); x.onclick = () => { if (sel) select(null); else closeSheet(); }; tb.appendChild(x); }
  el.appendChild(tb);
  const ib = h(`<div class="ibody"></div>`); ib.appendChild(body); el.appendChild(ib);
}
const frag = (html) => { const t = document.createElement('template'); t.innerHTML = html; return t.content; };
const tab = (tabs) => S.tab || tabs[0][0];
const findingsFor = (pred) => findings().filter(pred);
function findingList(list) {
  if (!list.length) return '<div class="check"><span class="s ok">✓</span>no findings</div>';
  return list.map(f => `<div class="check" data-target="${esc(f.target)}"><span class="s ${f.level === 'error' ? 'bad' : f.level === 'warn' ? 'wn' : 'inf'}">${f.level === 'error' ? '✕' : f.level === 'warn' ? '!' : 'i'}</span><div>${esc(f.message)} <span class="faint">${esc(f.rule)}</span></div></div>`).join('');
}
function bindFindings(root) { root.querySelectorAll('[data-target]').forEach(n => n.onclick = () => select(targetSel(n.dataset.target), true)); }
function commentsHtml(list) {
  return list.map(c => `<div class="msg ${c.author === 'you' ? 'me' : 'ag'}"><div class="w"><b>${esc(c.author === 'you' ? 'You' : c.author)}</b>${fmtTime(c.at)}${c.target ? ` · ${esc(c.target)}` : ''}</div>${esc(c.text)}</div>`).join('') || '<div class="faint">No comments yet.</div>';
}
function chatBox(root, target) {
  const box = h(`<div class="chat"><input class="fld" placeholder="${target ? 'Comment on ' + esc(target) : 'Write to the agents on this board'}…"><button class="btn soft">Send</button></div>`);
  const send = async () => {
    const v = box.querySelector('input').value.trim(); if (!v) return;
    try { await api(D('/comments'), { method: 'POST', body: { text: v, author: 'you', ...(target ? { target } : {}) } }); box.querySelector('input').value = ''; await refresh(); }
    catch (e) { toast(e.message, true); }
  };
  box.querySelector('button').onclick = send;
  box.querySelector('input').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  root.appendChild(box);
}

/* table */
function inspTable(d, sel) {
  const t = d.tables.find(x => x.name === sel.id);
  const tabs = [['table', t.name], ['samples', 'Sample rows'], ['chat', 'Comments']];
  const root = frag('');
  const T = tab(tabs);
  if (T === 'table') {
    const sec = h(`<div class="sec"><h5>Table <span class="row2"><button class="btn sm no" data-a="del">Delete</button></span></h5>
      <div class="form"><label>Name</label><input class="fld" data-f="name" value="${esc(t.name)}">
      <label>Module</label><input class="fld" data-f="module" value="${esc(t.module || '')}" list="modlist" placeholder="none">
      <label>Kind</label><select class="fld" data-f="kind"><option value="table">table</option><option value="view" ${t.kind === 'view' ? 'selected' : ''}>view</option></select>
      <label>Note</label><textarea class="fld" data-f="note" placeholder="What this table holds and why">${esc(t.note || '')}</textarea></div>
      <datalist id="modlist">${d.modules.map(m => `<option value="${esc(m.name)}">`).join('')}</datalist></div>`);
    sec.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
      const f = inp.dataset.f, v = inp.value.trim();
      if (f === 'name') { if (v && v !== t.name) { S.sel = { kind: 'table', id: v }; op({ op: 'set-table', table: t.name, name: v }); } }
      else op({ op: 'set-table', table: t.name, [f]: f === 'module' || f === 'note' ? (v || null) : v });
    });
    sec.querySelector('[data-a=del]').onclick = async () => { if (await confirmBox(`Delete table ${t.name}?`, 'Steps stop touching it and its state machines go too. Undo brings it back.')) { S.sel = null; op({ op: 'remove-table', table: t.name }); } };
    root.appendChild(sec);
    const cols = h(`<div class="sec"><h5>Columns <button class="btn sm out" data-a="add">+ column</button></h5><div class="hscroll"><table class="grid cols"><tr><th>name</th><th>type</th><th title="nullable">null</th><th>pk</th><th>references</th><th></th></tr></table></div></div>`);
    const grid = cols.querySelector('table');
    for (const c of t.columns) {
      const tr = h(`<tr class="${sel.column === c.name ? 'hl' : ''}"><td><input type="text" data-f="name" value="${esc(c.name)}"></td><td><input type="text" data-f="type" value="${esc(c.type)}" list="typelist"></td>
        <td class="c"><input type="checkbox" data-f="nullable" ${c.nullable ? 'checked' : ''}></td><td class="c"><input type="checkbox" data-f="pk" ${c.pk ? 'checked' : ''}></td>
        <td><input type="text" data-f="ref" value="${esc(c.ref ? c.ref.table + '.' + c.ref.column : '')}" placeholder="—" list="reflist" title="${c.ref && c.fk === false ? 'logical reference, no constraint' : ''}"></td><td><button class="rm" title="Remove column">✕</button></td></tr>`);
      tr.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
        const f = inp.dataset.f;
        if (f === 'nullable' || f === 'pk') return op({ op: 'set-column', table: t.name, column: c.name, [f]: inp.checked });
        const v = inp.value.trim();
        if (f === 'ref') { if (!v) return op({ op: 'set-column', table: t.name, column: c.name, ref: null }); const [rt, rc = 'id'] = v.split('.'); return op({ op: 'set-column', table: t.name, column: c.name, ref: { table: rt, column: rc } }); }
        if (v && v !== c[f]) op({ op: 'set-column', table: t.name, column: c.name, [f]: v });
      });
      tr.querySelector('.rm').onclick = () => op({ op: 'remove-column', table: t.name, column: c.name });
      grid.appendChild(tr);
    }
    cols.appendChild(h(`<datalist id="typelist">${['uuid', 'text', 'int', 'bigint', 'numeric(10,2)', 'boolean', 'date', 'timestamptz', 'jsonb', 'tstzrange', ...d.enums.map(e => e.name)].map(x => `<option value="${esc(x)}">`).join('')}</datalist>`));
    cols.appendChild(h(`<datalist id="reflist">${d.tables.flatMap(x => x.columns.filter(c => c.pk || c.unique).map(c => `<option value="${esc(x.name + '.' + c.name)}">`)).join('')}</datalist>`));
    cols.querySelector('[data-a=add]').onclick = async () => {
      const r = await form(`Add column to ${t.name}`, [['name', 'Name', 'e.g. created_at'], ['type', 'Type', 'e.g. timestamptz'], ['ref', 'References', 'table.column (optional)']]);
      if (!r?.name) return;
      const [rt, rc = 'id'] = (r.ref || '').split('.');
      op({ op: 'add-column', table: t.name, column: { name: r.name, type: r.type || 'text', ...(r.ref ? { ref: { table: rt, column: rc } } : {}) } });
    };
    const c = sel.column && t.columns.find(x => x.name === sel.column);
    if (c) {
      const cs = h(`<div class="sec"><h5>Column ${esc(c.name)}</h5><div class="form"><label>Default</label><input class="fld" data-f="default" value="${esc(c.default || '')}" placeholder="none"><label>Unique</label><input type="checkbox" data-f="unique" ${c.unique ? 'checked' : ''}>${c.ref ? `<label>Constraint</label><label class="check" style="padding:0"><input type="checkbox" data-f="fk" ${c.fk === false ? '' : 'checked'}> foreign key constraint (off = logical reference)</label>` : ''}<label>Note</label><textarea class="fld" data-f="note">${esc(c.note || '')}</textarea></div></div>`);
      cs.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
        const f = inp.dataset.f;
        if (f === 'unique' || f === 'fk') return op({ op: 'set-column', table: t.name, column: c.name, [f]: inp.checked });
        op({ op: 'set-column', table: t.name, column: c.name, [f]: inp.value.trim() || null });
      });
      root.appendChild(cols); root.appendChild(cs);
    } else root.appendChild(cols);
    const fs = h(`<div class="sec"><h5>Rules</h5>${findingList(findingsFor(f => f.target === `table:${t.name}` || f.target.startsWith(`column:${t.name}.`)))}</div>`);
    bindFindings(fs); root.appendChild(fs);
    const used = d.steps.filter(s => s.touches.some(x => x.table === t.name));
    if (used.length) root.appendChild(h(`<div class="sec"><h5>Used by the process</h5>${used.map(s => { const x = s.touches.find(y => y.table === t.name); return `<div class="plan"><span class="chip c-mod">${x.op}</span>${esc(s.id)} ${esc(s.title)}${x.columns ? ` <span class="faint">${esc(x.columns.join(', '))}</span>` : ''}</div>`; }).join('')}</div>`));
  } else if (T === 'samples') {
    const rows = structuredClone(t.samples || []);
    const sec = h(`<div class="sec"><h5>Sample rows <span class="row2"><button class="btn sm out" data-a="add">+ row</button></span></h5><div style="overflow-x:auto"><table class="grid"><tr>${t.columns.map(c => `<th>${esc(c.name)}</th>`).join('')}<th></th></tr></table></div><div class="faint" style="margin-top:6px">Realistic rows show whether the model holds real data before a migration exists. Foreign keys can name the sample rows of the related tables.</div></div>`);
    const grid = sec.querySelector('table');
    const save = () => op({ op: 'set-samples', table: t.name, rows: rows.map(r => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== ''))) });
    rows.forEach((r, i) => {
      const tr = h(`<tr>${t.columns.map(c => `<td><input type="text" data-c="${esc(c.name)}" value="${esc(r[c.name] ?? '')}"></td>`).join('')}<td><button class="rm">✕</button></td></tr>`);
      tr.querySelectorAll('input').forEach(inp => inp.onchange = () => { r[inp.dataset.c] = inp.value; save(); });
      tr.querySelector('.rm').onclick = () => { rows.splice(i, 1); save(); };
      grid.appendChild(tr);
    });
    sec.querySelector('[data-a=add]').onclick = () => { rows.push({ [t.columns[0]?.name || 'id']: '…' }); save(); };
    root.appendChild(sec);
  } else {
    const sec = h(`<div class="sec"><h5>Comments on ${esc(t.name)}</h5>${commentsHtml(d.comments.filter(c => c.target === `table:${t.name}` || c.target?.startsWith(`column:${t.name}.`)))}</div>`);
    chatBox(sec, `table:${t.name}`); root.appendChild(sec);
  }
  return [tabs, root];
}

/* step */
function inspStep(d, sel) {
  const s = d.steps.find(x => x.id === sel.id);
  const tabs = [['step', `Step ${s.id}`], ['crud', 'CRUD matrix']];
  const root = frag('');
  if (tab(tabs) === 'step') {
    const sec = h(`<div class="sec"><h5>${esc(s.id)} <span class="row2">${s.lane ? `<span class="chip c-plat">lane: ${esc(s.lane)}</span>` : ''}<button class="btn sm no" data-a="del">Delete</button></span></h5>
      <div class="form"><label>Title</label><input class="fld" data-f="title" value="${esc(s.title)}">
      <label>Lane</label><input class="fld" data-f="lane" value="${esc(s.lane || '')}" list="lanelist">
      <label>Trigger</label><input class="fld" data-f="trigger" value="${esc(s.trigger || '')}" placeholder="e.g. cron, payment.succeeded">
      <label>Note</label><textarea class="fld" data-f="note">${esc(s.note || '')}</textarea></div>
      <datalist id="lanelist">${d.lanes.map(l => `<option value="${esc(l)}">`).join('')}</datalist></div>`);
    sec.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => { const f = inp.dataset.f, v = inp.value.trim(); if (f === 'title' || f === 'lane') { if (v) op({ op: 'set-step', id: s.id, [f]: v }); } else op({ op: 'set-step', id: s.id, [f]: v || null }); });
    sec.querySelector('[data-a=del]').onclick = async () => { if (await confirmBox(`Delete step ${s.id}?`, 'Its flows go too.')) { S.sel = null; op({ op: 'remove-step', id: s.id }); } };
    root.appendChild(sec);

    const touches = structuredClone(s.touches);
    const tsec = h(`<div class="sec"><h5>Data it touches <button class="btn sm out" data-a="add">+ table</button></h5><table class="grid"><tr><th>table</th><th>op</th><th>columns</th><th></th></tr></table>
      <datalist id="tbllist">${d.tables.map(t => `<option value="${esc(t.name)}">`).join('')}</datalist></div>`);
    const tables = new Set(d.tables.map(t => t.name));
    const save = () => op({ op: 'set-step', id: s.id, touches: touches.filter(t => t.table).map(t => ({ table: t.table, op: t.op, ...(t.columns?.length ? { columns: t.columns } : {}) })) });
    touches.forEach((t, i) => {
      const tr = h(`<tr><td><input type="text" data-f="table" value="${esc(t.table)}" list="tbllist" style="${tables.has(t.table) ? '' : 'color:var(--del)'}"></td><td><select data-f="op">${['C', 'R', 'U', 'D'].map(o => `<option ${o === t.op ? 'selected' : ''}>${o}</option>`).join('')}</select></td><td><input type="text" data-f="columns" value="${esc((t.columns || []).join(', '))}" placeholder="all"></td><td><button class="rm">✕</button></td></tr>`);
      tr.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => { const f = inp.dataset.f; t[f] = f === 'columns' ? inp.value.split(',').map(x => x.trim()).filter(Boolean) : inp.value.trim(); save(); });
      tr.querySelector('.rm').onclick = () => { touches.splice(i, 1); save(); };
      tsec.querySelector('table').appendChild(tr);
    });
    tsec.querySelector('[data-a=add]').onclick = async () => {
      const r = await form(`${s.id} touches…`, [['table', 'Table', d.tables.map(t => t.name).slice(0, 4).join(', ')], ['op', 'Operation', 'R', 'select:C,R,U,D'], ['columns', 'Columns', 'optional, comma separated']]);
      if (!r?.table) return;
      touches.push({ table: r.table, op: r.op || 'R', columns: (r.columns || '').split(',').map(x => x.trim()).filter(Boolean) }); save();
    };
    root.appendChild(tsec);

    const flows = d.flows.filter(f => f.from === s.id || f.to === s.id);
    const fsec = h(`<div class="sec"><h5>Flows <button class="btn sm out" data-a="add">+ next step</button></h5>${flows.map(f => `<div class="plan"><span class="chip c-plat">${f.from === s.id ? 'to' : 'from'}</span>${esc(f.from === s.id ? f.to : f.from)}${f.label ? ` <span class="faint">${esc(f.label)}</span>` : ''} <button class="btn sm" data-rm="${esc(f.from + '>' + f.to)}">✕</button></div>`).join('') || '<div class="faint">Not connected yet.</div>'}</div>`);
    fsec.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { const [from, to] = b.dataset.rm.split('>'); op({ op: 'remove-flow', from, to }); });
    fsec.querySelector('[data-a=add]').onclick = async () => {
      const r = await form(`Flow from ${s.id}`, [['to', 'To step', d.steps.filter(x => x.id !== s.id).map(x => x.id).join(', ')], ['label', 'Label', 'optional, e.g. after 15 min']]);
      if (r?.to) op({ op: 'add-flow', from: s.id, to: r.to, ...(r.label ? { label: r.label } : {}) });
    };
    root.appendChild(fsec);
    const trans = d.machines.flatMap(m => m.transitions.filter(t => t.step === s.id).map(t => `${m.table}.${m.column}: ${t.from} → ${t.to}`));
    if (trans.length) root.appendChild(h(`<div class="sec"><h5>State changes</h5>${trans.map(x => `<div class="plan"><span class="chip c-open">◎</span>${esc(x)}</div>`).join('')}</div>`));
    const fs = h(`<div class="sec"><h5>Rules</h5>${findingList(findingsFor(f => f.target === `step:${s.id}`))}</div>`);
    bindFindings(fs); root.appendChild(fs);
  } else root.appendChild(crudMatrix(d, s.id));
  return [tabs, root];
}
function crudMatrix(d, hl) {
  const tables = [...new Set([...d.tables.map(t => t.name), ...d.steps.flatMap(s => s.touches.map(t => t.table))])];
  const known = new Set(d.tables.map(t => t.name));
  const sec = h(`<div class="sec"><h5>Who touches what, across the whole process</h5><div style="overflow-x:auto"><table class="grid matrix"><tr><th></th>${d.steps.map(s => `<th title="${esc(s.title)}" style="${s.id === hl ? 'color:var(--accent)' : ''}">${esc(s.id)}</th>`).join('')}</tr>
    ${tables.map(t => `<tr><td class="${known.has(t) ? '' : 'bad'}">${esc(t)}${known.has(t) ? '' : ' ✕'}</td>${d.steps.map(s => { const x = s.touches.find(y => y.table === t); return `<td class="c ${s.id === hl && x ? 'on' : ''} ${x && !known.has(t) ? 'bad' : ''}">${x ? x.op : ''}</td>`; }).join('')}</tr>`).join('')}</table></div>
    <div class="faint" style="margin-top:6px">A table nobody reads, or a step with nowhere to write, shows up here first.</div></div>`);
  return sec;
}

/* assumption */
function inspAssumption(d, sel) {
  const a = d.assumptions.find(x => x.id === sel.id);
  const root = frag('');
  const sec = h(`<div class="sec"><h5>${esc(a.id)} <button class="btn sm no" data-a="del">Delete</button></h5><div class="form"><label>Status</label><select class="fld" data-f="status">${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${l}</option>`).join('')}</select><label>Text</label><textarea class="fld" data-f="text" rows="5">${esc(a.text)}</textarea><label>By</label><span class="muted">${esc(a.author || '—')}</span></div></div>`);
  sec.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => { const v = inp.value.trim(); if (v) op({ op: 'set-assumption', id: a.id, [inp.dataset.f]: v }); });
  sec.querySelector('[data-a=del]').onclick = () => { S.sel = null; op({ op: 'remove-assumption', id: a.id }); };
  root.appendChild(sec);
  const cs = h(`<div class="sec"><h5>Discussion</h5>${commentsHtml(d.comments.filter(c => c.target === `assumption:${a.id}`))}</div>`);
  chatBox(cs, `assumption:${a.id}`); root.appendChild(cs);
  return [[['a', `Assumption ${a.id}`]], root];
}

/* machine */
function inspMachine(d, sel) {
  const m = d.machines.find(x => `${x.table}.${x.column}` === sel.id);
  const root = frag('');
  const sec = h(`<div class="sec"><h5>States of ${esc(sel.id)} <button class="btn sm no" data-a="del">Delete</button></h5>
    <div class="form"><label>States</label><input class="fld" data-f="states" value="${esc(m.states.join(', '))}"><label>Transitions</label><textarea class="fld" data-f="tr" rows="${Math.max(4, m.transitions.length + 1)}" spellcheck="false" style="font-family:var(--mono);font-size:11.5px">${esc(m.transitions.map(t => `${t.from} -> ${t.to}${t.step ? ' : ' + t.step : ''}${t.label ? ' : ' + t.label : ''}`).join('\n'))}</textarea></div>
    <div class="faint" style="margin-top:6px">The first state is where every row starts. One transition per line: <code>from -> to : S4</code>. Step ids link to the process.</div></div>`);
  const save = () => {
    const states = sec.querySelector('[data-f=states]').value.split(',').map(x => x.trim()).filter(Boolean);
    const transitions = sec.querySelector('[data-f=tr]').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const [arrow, ...rest] = l.split(':').map(x => x.trim()); const [from, to] = arrow.split(/->|→/).map(x => x.trim());
      const step = rest.find(x => d.steps.some(s => s.id === x)); const label = rest.filter(x => x !== step).join(' ') || undefined;
      return { from, to, ...(step ? { step } : {}), ...(label ? { label } : {}) };
    });
    op({ op: 'set-machine', table: m.table, column: m.column, states, transitions });
  };
  sec.querySelectorAll('[data-f]').forEach(inp => inp.onchange = save);
  sec.querySelector('[data-a=del]').onclick = () => { S.sel = null; op({ op: 'remove-machine', table: m.table, column: m.column }); };
  root.appendChild(sec);
  const fs = h(`<div class="sec"><h5>Rules</h5>${findingList(findingsFor(f => f.target === `machine:${sel.id}`))}</div>`);
  bindFindings(fs); root.appendChild(fs);
  return [[['m', 'State machine']], root];
}

/* proposal */
function opWords(o) {
  const col = (c) => `${c.name} ${c.type}${c.pk ? ' pk' : ''}${c.ref ? ` → ${c.ref.table}.${c.ref.column}` : ''}`;
  switch (o.op) {
    case 'add-table': return ['+', 'c-ok', `table <code>${esc(o.table)}</code>${o.module ? ` in ${esc(o.module)}` : ''}${o.columns?.length ? ` (${o.columns.length} columns)` : ''}`];
    case 'remove-table': return ['−', 'c-no', `table <code>${esc(o.table)}</code>`];
    case 'set-table': return ['~', 'c-open', `table <code>${esc(o.table)}</code>${o.name ? ` renamed to <code>${esc(o.name)}</code>` : ''}${o.module !== undefined ? ` module ${esc(o.module || 'none')}` : ''}`];
    case 'add-column': return ['+', 'c-ok', `<code>${esc(o.table)}.${esc(col(o.column))}</code>`];
    case 'remove-column': return ['−', 'c-no', `<code>${esc(o.table)}.${esc(o.column)}</code>`];
    case 'set-column': return ['~', 'c-open', `<code>${esc(o.table)}.${esc(o.column)}</code>: ${esc(Object.entries(o).filter(([k]) => !['op', 'table', 'column'].includes(k)).map(([k, v]) => `${k} ${v && typeof v === 'object' ? v.table + '.' + v.column : v}`).join(', '))}`];
    case 'add-step': return ['+', 'c-ok', `step ${esc(o.id || '')} “${esc(o.title)}”${o.lane ? ` in ${esc(o.lane)}` : ''}`];
    case 'set-step': return ['~', 'c-open', `step ${esc(o.id)}${o.title ? ` “${esc(o.title)}”` : ''}${o.touches ? ': ' + esc(o.touches.map(t => t.op + ' ' + t.table).join(', ')) : ''}`];
    case 'remove-step': return ['−', 'c-no', `step ${esc(o.id)}`];
    case 'add-assumption': return ['+', 'c-ok', `assumption “${esc(o.text)}”`];
    case 'set-assumption': return ['~', 'c-open', `assumption ${esc(o.id)}${o.status ? ` → ${esc(o.status)}` : ''}${o.text ? `: “${esc(o.text)}”` : ''}`];
    case 'remove-assumption': return ['−', 'c-no', `assumption ${esc(o.id)}`];
    case 'set-machine': return ['~', 'c-open', `states of <code>${esc(o.table)}.${esc(o.column)}</code>: ${esc(o.states.join(' → '))}`];
    case 'set-enum': return ['~', 'c-open', `enum <code>${esc(o.name)}</code>: ${esc(o.values.join(', '))}`];
    case 'add-flow': return ['+', 'c-ok', `flow ${esc(o.from)} → ${esc(o.to)}`];
    case 'move': return ['·', 'c-plat', `move ${esc(o.kind)} ${esc(o.id)}`];
    default: return ['~', 'c-plat', esc(o.op)];
  }
}
function inspProposal(d, sel) {
  const p = d.proposals.find(x => x.id === sel.id);
  const root = frag('');
  const prev = S.preview?.pid === p.id;
  const st = { open: ['open', 'c-open'], accepted: ['accepted', 'c-ok'], rejected: ['rejected', 'c-no'] }[p.status];
  const sec = h(`<div class="sec"><h5>from ${esc(p.author)} · ${fmtTime(p.createdAt)} <span class="chip ${st[1]}">${st[0]}</span></h5><div class="lead">${esc(p.title)}</div>${p.rationale ? `<div class="muted" style="white-space:pre-wrap">${esc(p.rationale)}</div>` : ''}${p.reason ? `<div class="faint" style="margin-top:6px">${esc(p.decidedBy)}: ${esc(p.reason)}</div>` : ''}</div>`);
  root.appendChild(sec);
  const ch = h(`<div class="sec"><h5>Changes <span class="faint">${p.ops.length} op${p.ops.length === 1 ? '' : 's'}</span></h5>${p.ops.map(o => { const [sym, cls, words] = opWords(o); return `<div class="plan"><span class="chip ${cls}">${sym}</span><span>${words}</span></div>`; }).join('')}</div>`);
  root.appendChild(ch);
  if (prev && S.preview) {
    const before = new Set(findings().map(f => f.message));
    const now = S.data.findings.map(f => f.message);
    const fixed = S.data.findings.filter(f => !S.preview.findings.some(g => g.message === f.message));
    const added = S.preview.findings.filter(f => !now.includes(f.message));
    const fs = h(`<div class="sec"><h5>Effect on the rules</h5>${fixed.map(f => `<div class="check"><span class="s ok">✓</span>fixes: ${esc(f.message)}</div>`).join('')}${added.map(f => `<div class="check"><span class="s ${f.level === 'error' ? 'bad' : 'wn'}">${f.level === 'error' ? '✕' : '!'}</span>adds: ${esc(f.message)}</div>`).join('')}${!fixed.length && !added.length ? '<div class="check"><span class="s ok">✓</span>no change in findings</div>' : ''}</div>`);
    void before; root.appendChild(fs);
  }
  if (p.status === 'open') {
    const act = h(`<div class="sec"><div class="row2"><button class="btn ${prev ? 'out' : 'soft'}" data-a="prev">${prev ? 'Hide preview' : '◐ Preview on canvas'}</button><button class="btn ok" data-a="acc">✓ Accept</button><button class="btn no" data-a="rej">Reject…</button></div></div>`);
    act.querySelector('[data-a=prev]').onclick = () => togglePreview(p.id);
    act.querySelector('[data-a=acc]').onclick = () => decide(p.id, true);
    act.querySelector('[data-a=rej]').onclick = async () => { const r = await form(`Reject ${p.id}`, [['reason', 'Why', 'The agent reads this', 'area']]); if (r) decide(p.id, false, r.reason); };
    root.appendChild(act);
  }
  const cs = h(`<div class="sec"><h5>Discussion</h5>${commentsHtml(d.comments.filter(c => c.target === `proposal:${p.id}`))}</div>`);
  chatBox(cs, `proposal:${p.id}`); root.appendChild(cs);
  return [[['p', `Proposal ${p.id}`]], root];
}
async function togglePreview(pid) {
  if (S.preview?.pid === pid) { S.preview = null; render(); if (isPhone()) openSheet('half'); return; }
  await loadPreview(pid);
  render();
  if (S.preview) { if (isPhone()) openSheet('peek'); requestAnimationFrame(fitChanges); }
}
/** Brings what a proposal changes into view, above the sheet on a phone. */
function fitChanges() {
  const d = shown(); if (!d?._preview) return;
  const r = [];
  for (const t of d.tables) if (t._st) r.push([t.x, t.y, TABLE_W, tableH(t)]);
  if (!r.length || !isPhone()) {
    for (const s of d.steps) if (s._st) r.push([s.x, s.y, STEP_W, 70]);
    for (const a of d.assumptions) if (a._st) r.push([a.x, a.y, 220, 110]);
  }
  if (!r.length) return;
  const x0 = Math.min(...r.map(b => b[0])) - 30, y0 = Math.min(...r.map(b => b[1])) - 40;
  const x1 = Math.max(...r.map(b => b[0] + b[2])) + 30, y1 = Math.max(...r.map(b => b[1] + b[3])) + 30;
  const W = cv.clientWidth, H = cv.clientHeight - (isPhone() && document.body.classList.contains('sheet-open') ? $('#insp').offsetHeight : 0) - (isPhone() ? 70 : 0);
  const s = Math.max(isPhone() ? 0.5 : 0.2, Math.min(1, Math.min((W - 40) / (x1 - x0), H / (y1 - y0))));
  const top = isPhone() ? 70 : 0;
  S.view = { s, x: Math.max(isPhone() ? 66 - x0 * s : -Infinity, (W - (x1 - x0) * s) / 2 - x0 * s), y: top + Math.max(0, (H - (y1 - y0) * s) / 2) - y0 * s };
  applyView();
}
async function decide(pid, accept, reason) {
  try {
    await api(D(`/proposals/${encodeURIComponent(pid)}`), { method: 'POST', body: { accept, by: 'you', ...(reason ? { reason } : {}) } });
    if (S.preview?.pid === pid) S.preview = null;
    toast(`${pid} ${accept ? 'accepted' : 'rejected'}`);
  } catch (e) { toast(e.message, true); }
  await refresh(); loadDesigns();
}
function renderPreviewBar() {
  const bar = $('#previewBar');
  if (!S.preview) { bar.hidden = true; return; }
  const p = design()?.proposals.find(x => x.id === S.preview.pid);
  bar.hidden = false;
  bar.innerHTML = `<b>Preview ${esc(S.preview.pid)}</b><span class="muted">${esc(p?.title || '')}</span><span class="lg"><span class="a">added</span><span class="d">removed</span><span class="c">changed</span></span>${p?.status === 'open' ? '<button class="btn ok sm" data-a="acc">✓ Accept</button>' : ''}<button class="btn sm out" data-a="x">Close</button>`;
  bar.querySelector('[data-a=x]').onclick = () => { S.preview = null; render(); };
  const acc = bar.querySelector('[data-a=acc]'); if (acc) acc.onclick = () => decide(S.preview.pid, true);
}

/* board */
function inspBoard(d) {
  const tabs = [['board', 'Board'], ['chat', `Comments${d.comments.length ? ' ' + d.comments.length : ''}`], ['history', 'History']];
  const root = frag('');
  const T = tab(tabs);
  if (T === 'board') {
    const ps = h(`<div class="sec"><h5>Purpose</h5><textarea class="fld" rows="3" placeholder="What this board settles, before code is written">${esc(d.purpose || '')}</textarea></div>`);
    ps.querySelector('textarea').onchange = (e) => op({ op: 'set-design', purpose: e.target.value.trim() });
    root.appendChild(ps);
    const F = S.data.findings || [];
    const acc = d.assumptions.filter(a => a.status === 'accepted').length, open = d.proposals.filter(p => p.status === 'open');
    const sum = h(`<div class="sec"><h5>Where we stand</h5>
      <div class="check"><span class="s ${acc === d.assumptions.length ? 'ok' : 'wn'}">${acc === d.assumptions.length ? '✓' : '◐'}</span>${acc} of ${d.assumptions.length} assumptions accepted</div>
      ${open.map(p => `<div class="check" data-p="${esc(p.id)}"><span class="s wn">◐</span>${esc(p.id)} from ${esc(p.author)} waits: ${esc(p.title)}</div>`).join('')}
      ${d.approved ? `<div class="check"><span class="s ${d.draft ? 'wn' : 'ok'}">${d.draft ? '◐' : '✓'}</span>v${d.approved.version} approved by ${esc(d.approved.by)} ${new Date(d.approved.at).toLocaleString()}${d.draft ? ', changed since' : ''}</div>` : '<div class="check"><span class="s inf">i</span>not approved yet</div>'}</div>`);
    sum.querySelectorAll('[data-p]').forEach(n => n.onclick = () => select({ kind: 'proposal', id: n.dataset.p }));
    root.appendChild(sum);
    for (const [lvl, title] of [['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Notes']]) {
      const list = F.filter(f => f.level === lvl);
      if (!list.length && lvl !== 'error') continue;
      const s = h(`<div class="sec"><h5>${title} <span class="faint">${list.length}</span></h5>${list.length ? findingList(list) : '<div class="check"><span class="s ok">✓</span>no errors</div>'}</div>`);
      bindFindings(s); root.appendChild(s);
    }
    const props = d.proposals.slice().reverse();
    if (props.length) {
      const s = h(`<div class="sec"><h5>Proposals</h5>${props.map(p => `<div class="check" data-p="${esc(p.id)}"><span class="chip ${p.status === 'open' ? 'c-ag' : p.status === 'accepted' ? 'c-ok' : 'c-no'}">${esc(p.id)}</span><div>${esc(p.title)} <span class="faint">${esc(p.author)} · ${p.status}</span></div></div>`).join('')}</div>`);
      s.querySelectorAll('[data-p]').forEach(n => n.onclick = () => select({ kind: 'proposal', id: n.dataset.p }));
      root.appendChild(s);
    }
  } else if (T === 'chat') {
    const s = h(`<div class="sec"><h5>Comments</h5>${commentsHtml(d.comments.slice(-80))}</div>`);
    chatBox(s); root.appendChild(s);
    setTimeout(() => { const ib = $('#insp .ibody'); if (ib) ib.scrollTop = ib.scrollHeight; }, 0);
  } else {
    if (!S.history) { loadHistory(); root.appendChild(h(`<div class="sec faint">Loading…</div>`)); }
    else root.appendChild(h(`<div class="sec"><h5>History</h5>${S.history.map(e => `<div class="hist"><time>${fmtTime(e.at)}</time><span><b>${esc(e.author === 'you' ? 'You' : e.author)}</b> ${esc(histWords(e))}</span></div>`).join('') || '<div class="faint">Nothing yet.</div>'}</div>`));
  }
  return [tabs, root];
}
function histWords(e) {
  switch (e.kind) {
    case 'ops': return e.ops?.length === 1 ? e.ops[0].op + ' ' + (e.ops[0].table || e.ops[0].id || e.ops[0].name || '') : `${e.ops?.length ?? 0} changes`;
    case 'accept': return `accepted ${e.proposal}`;
    case 'reject': return `rejected ${e.proposal}`;
    case 'propose': return `proposed ${e.proposal}`;
    case 'approve': return `approved v${e.version}`;
    case 'undo': return 'undid a change';
    case 'join': return `joined as ${e.role}`;
    case 'create': return 'created the board';
    default: return e.kind;
  }
}

/* ---------- dialogs ---------- */
function form(title, fields) {
  return new Promise((resolve) => {
    const ov = $('#overlay');
    const m = h(`<div class="modal small"><div class="mh"><b>${esc(title)}</b></div><div class="mb"><div class="form">${fields.map(([k, label, ph, kind]) => {
      if (kind === 'area') return `<label>${esc(label)}</label><textarea class="fld" data-k="${k}" rows="3" placeholder="${esc(ph)}"></textarea>`;
      if (kind?.startsWith('select:')) return `<label>${esc(label)}</label><select class="fld" data-k="${k}">${kind.slice(7).split(',').map(o => `<option ${o === ph ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
      return `<label>${esc(label)}</label><input class="fld" data-k="${k}" placeholder="${esc(ph)}">`;
    }).join('')}</div></div><div class="mf"><button class="btn out" data-a="no">Cancel</button><button class="btn pri" data-a="ok">OK</button></div></div>`);
    ov.innerHTML = ''; ov.appendChild(m); ov.hidden = false;
    const close = (v) => { ov.hidden = true; ov.innerHTML = ''; resolve(v); };
    const ok = () => close(Object.fromEntries([...m.querySelectorAll('[data-k]')].map(i => [i.dataset.k, i.value.trim()])));
    m.querySelector('[data-a=ok]').onclick = ok;
    m.querySelector('[data-a=no]').onclick = () => close(null);
    m.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(null); if (e.key === 'Enter' && (e.target.tagName !== 'TEXTAREA' || e.metaKey || e.ctrlKey)) ok(); });
    ov.onclick = (e) => { if (e.target === ov) close(null); };
    m.querySelector('[data-k]')?.focus();
  });
}
function confirmBox(title, textIn) {
  return new Promise((resolve) => {
    const ov = $('#overlay');
    const m = h(`<div class="modal small"><div class="mh"><b>${esc(title)}</b></div><div class="mb muted">${esc(textIn)}</div><div class="mf"><button class="btn out" data-a="no">Cancel</button><button class="btn pri" data-a="ok">Delete</button></div></div>`);
    ov.innerHTML = ''; ov.appendChild(m); ov.hidden = false;
    const close = (v) => { ov.hidden = true; ov.innerHTML = ''; resolve(v); };
    m.querySelector('[data-a=ok]').onclick = () => close(true);
    m.querySelector('[data-a=no]').onclick = () => close(false);
    m.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(false); if (e.key === 'Enter') close(true); });
    m.querySelector('[data-a=ok]').focus();
  });
}

function shareModal() {
  const d = design(); if (!d) return;
  const ov = $('#overlay');
  const m = h(`<div class="modal"><div class="mh"><b>Share “${esc(d.name)}”</b><span class="spacer"></span><button class="btn out" data-a="x">Close</button></div>
    <div class="mb cols"><div>
      <h6>Sessions and agents</h6>
      <table class="grid" style="font-family:var(--sans);font-size:12.5px"><tbody id="plist"></tbody></table>
      <div class="row2" style="margin-top:8px"><input class="fld" id="pname" placeholder="session name, e.g. core12-payments" style="flex:1"><select class="fld" id="prole" style="width:auto"><option value="propose">proposes</option><option value="edit">edits</option><option value="read">reads</option></select><button class="btn soft" id="padd">Add</button></div>
      <div class="faint" style="margin-top:8px"><b>edits</b> changes the board directly · <b>proposes</b> only through proposals you accept · <b>reads</b> takes the board as context</div>
      <h6 style="margin-top:16px">Where it lives</h6>
      <pre class="code">${esc(S.data.file)}\n<span class="cm">${esc(S.data.file.replace(/\.board\.json$/, '/'))}history.jsonl   every operation\n${esc(S.data.file.replace(/\.board\.json$/, '/'))}v&lt;N&gt;.json      approved versions</span></pre>
      <div class="faint" style="margin-top:6px">A plain file in the repo, no cloud: it goes with the branch, and the PR shows how the design changed.</div>
    </div><div>
      <h6>How an agent works with it</h6>
      <pre class="code"><span class="cm"># join (another session)</span>
<span class="fn">diffboard design join</span> ${esc(d.id)} --as &lt;session&gt; --role propose

<span class="cm"># read it as text for the context</span>
<span class="fn">diffboard design show</span> ${esc(d.id)} --format md

<span class="cm"># change it with operations, not drawing</span>
<span class="fn">diffboard design op</span> ${esc(d.id)} add-column reservation \\
  created_by uuid

<span class="cm"># a bigger change as a proposal to accept</span>
<span class="fn">diffboard design propose</span> ${esc(d.id)} --title "…" \\
  --ops-file p.ops.json

<span class="cm"># wait for your decision</span>
<span class="fn">diffboard design wait</span> ${esc(d.id)} P1</pre>
      <div class="row2" style="margin-top:8px"><button class="btn out" id="copyCli">Copy</button><span class="faint">Board link: <code>${esc(location.href)}</code></span></div>
    </div></div></div>`);
  ov.innerHTML = ''; ov.appendChild(m); ov.hidden = false;
  const close = () => { ov.hidden = true; ov.innerHTML = ''; };
  m.querySelector('[data-a=x]').onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  m.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
  const fill = () => {
    const tb = m.querySelector('#plist'); tb.innerHTML = '';
    for (const p of design().participants) {
      const tr = h(`<tr><td><span class="dot round" style="background:${colorOf(p.name)}"></span> ${esc(p.name)}</td><td><select class="fld">${['edit', 'propose', 'read'].map(r => `<option value="${r}" ${r === p.role ? 'selected' : ''}>${{ edit: 'edits', propose: 'proposes', read: 'reads' }[r]}</option>`).join('')}</select></td><td><button class="rm" title="Remove">✕</button></td></tr>`);
      tr.querySelector('select').onchange = async (e) => { try { await api(D('/participants'), { method: 'POST', body: { name: p.name, role: e.target.value } }); await refresh(); fill(); } catch (er) { toast(er.message, true); } };
      tr.querySelector('.rm').onclick = async () => { try { await api(D(`/participants/${encodeURIComponent(p.name)}`), { method: 'DELETE' }); await refresh(); fill(); } catch (er) { toast(er.message, true); } };
      tb.appendChild(tr);
    }
    if (!design().participants.length) tb.appendChild(h(`<tr><td class="faint">Only you so far.</td></tr>`));
  };
  fill();
  m.querySelector('#padd').onclick = async () => {
    const name = m.querySelector('#pname').value.trim(); if (!name) return;
    try { await api(D('/participants'), { method: 'POST', body: { name, role: m.querySelector('#prole').value } }); m.querySelector('#pname').value = ''; await refresh(); fill(); }
    catch (e) { toast(e.message, true); }
  };
  m.querySelector('#copyCli').onclick = () => copy(m.querySelector('.mb > div:last-child pre').innerText);
}

async function copy(textIn) {
  try { await navigator.clipboard.writeText(textIn); }
  catch { const ta = h(`<textarea style="position:fixed;opacity:0"></textarea>`); ta.value = textIn; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  toast('Copied');
}

/* ---------- title bar actions ---------- */
$('#dname').onclick = async () => {
  const d = design(); if (!d) return;
  const r = await form('Rename design', [['name', 'Name', d.name]]);
  if (r?.name) op({ op: 'set-design', name: r.name }).then(loadDesigns);
};
$('#undo').onclick = undo;
async function undo() {
  if (!S.data?.canUndo) return;
  try { await api(D('/undo'), { method: 'POST', body: { author: 'you' } }); toast('Undone'); } catch (e) { toast(e.message, true); }
  await refresh();
}
$('#approveBtn').onclick = async () => {
  const d = design(); if (!d) return;
  const errs = (S.data.findings || []).filter(f => f.level === 'error').length;
  const open = d.proposals.filter(p => p.status === 'open').length;
  const ok = await new Promise((resolve) => {
    const ov = $('#overlay');
    const m = h(`<div class="modal small"><div class="mh"><b>Approve v${(d.approved?.version ?? 0) + 1}</b></div><div class="mb"><p class="muted" style="margin-top:0">Freezes the current model as a version next to the board file. The implementing agent builds from it, and the board shows what changed since.</p>${errs ? `<div class="check"><span class="s bad">✕</span>${errs} rule error${errs === 1 ? '' : 's'} still open</div>` : '<div class="check"><span class="s ok">✓</span>no rule errors</div>'}${open ? `<div class="check"><span class="s wn">◐</span>${open} proposal${open === 1 ? '' : 's'} waiting</div>` : ''}</div><div class="mf"><button class="btn out" data-a="no">Cancel</button><button class="btn pri" data-a="ok">Approve${errs ? ' anyway' : ''}</button></div></div>`);
    ov.innerHTML = ''; ov.appendChild(m); ov.hidden = false;
    const close = (v) => { ov.hidden = true; ov.innerHTML = ''; resolve(v); };
    m.querySelector('[data-a=ok]').onclick = () => close(true); m.querySelector('[data-a=no]').onclick = () => close(false);
    m.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(false); });
    m.querySelector('[data-a=ok]').focus();
  });
  if (!ok) return;
  try { const r = await api(D('/approve'), { method: 'POST', body: { by: 'you' } }); toast(`v${r.version} approved${r.errors?.length ? ` with ${r.errors.length} rule error${r.errors.length === 1 ? '' : 's'}` : ''}`); }
  catch (e) { toast(e.message, true); }
  await refresh(); loadDesigns();
};
$('#shareBtn').onclick = shareModal;
$('#exportBtn').onclick = (e) => { e.stopPropagation(); $('#exportMenu').hidden = !$('#exportMenu').hidden; };
document.addEventListener('click', () => { $('#exportMenu').hidden = true; });
$('#exportMenu').onclick = async (e) => {
  const b = e.target.closest('[data-fmt]'); if (!b) return;
  try { copy(await api(D(`/export?format=${b.dataset.fmt}`))); } catch (er) { toast(er.message, true); }
};

/* ---------- keys ---------- */
document.addEventListener('keydown', (e) => {
  const inField = e.target.closest?.('input,textarea,select');
  if (e.key === ' ' && !inField) { spaceDown = true; cv.classList.add('space'); if (e.target === document.body || e.target === cv) e.preventDefault(); }
  if (inField || S.editing || !$('#overlay').hidden) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); fit(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') { if (S.tool !== 'select') setTool('select'); else if (S.preview) { S.preview = null; render(); } else select(null); }
  const tools = { v: 'select', t: 'table', s: 'step', a: 'assumption' };
  if (tools[e.key] && design()) setTool(tools[e.key]);
  if (e.key === 'f') fit();
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel && !S.preview) {
    const s = S.sel;
    if (s.kind === 'table' && s.column) op({ op: 'remove-column', table: s.id, column: s.column });
  }
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; cv.classList.remove('space'); } });

/* ---------- live ---------- */
function live() {
  const es = new EventSource('events');
  let t;
  es.addEventListener('design', (e) => {
    let msg = {}; try { msg = JSON.parse(e.data); } catch { /* ignore */ }
    clearTimeout(t);
    t = setTimeout(() => { loadDesigns(); if (msg.design === S.id && !S.drag && !S.editing) refresh(); }, 120);
  });
  es.onerror = () => { /* the browser reconnects on its own */ };
}
setInterval(seen, 60_000);
window.addEventListener('hashchange', async () => { const q = hashParams(); const id = q.get('d'); if (id && id !== S.id) await openDesign(id); await applyDeepLink(q); });
window.addEventListener('resize', applyView);

/* render hooks that depend on S.preview */
const _render = render;
render = function () { _render(); renderPreviewBar(); if (S.data && !S.fitted) { S.fitted = true; fit(); } };

// Behind the harness proxy (/diffboard/...) only the design routes exist: no way back to the diff board.
if (location.pathname.startsWith('/diffboard/')) document.body.classList.add('proxied');

(async function init() {
  await loadDesigns();
  const q = hashParams();
  const id = q.get('d') || S.designs[0]?.id;
  if (id) await openDesign(id); else render();
  await applyDeepLink(q);
  if (!new URLSearchParams(location.search).has('nolive')) live();
})();

/* ---------- deep links: #d=<id>&p=P1 (open a proposal, previewed), &sel=table:reservation, &panel=1 ---------- */
function hashParams() { return new URLSearchParams(location.hash.replace(/^#/, '')); }
async function applyDeepLink(q) {
  if (!S.data) return;
  const p = q.get('p'), sel = q.get('sel');
  // a link without that proposal ends a preview opened by an earlier link
  if (S.preview && S.preview.pid !== p) { S.preview = null; render(); }
  if (p && design().proposals.some(x => x.id === p)) {
    select({ kind: 'proposal', id: p });
    if (q.get('preview') !== '0' && design().proposals.find(x => x.id === p).status === 'open' && S.preview?.pid !== p) await togglePreview(p);
  } else if (sel) { const t = targetSel(sel); select(t, true); }
  else if (q.get('panel')) openSheet('half');
}

/* ---------- phone panels ---------- */
const phoneQuery = matchMedia('(max-width: 800px)');
function isPhone() { return phoneQuery.matches; }
let lastSheet = 'half';
function sheetSize() { return document.body.classList.contains('sheet-open') ? lastSheet : 'half'; }
function openSheet(size = 'half') {
  if (!isPhone()) return;
  lastSheet = size;
  document.body.classList.add('sheet-open');
  document.body.classList.toggle('sheet-full', size === 'full');
  document.body.classList.toggle('sheet-peek', size === 'peek');
}
function closeSheet() { document.body.classList.remove('sheet-open', 'sheet-full', 'sheet-peek'); }
function setDock(open) { document.body.classList.toggle('dock-open', !!open && isPhone()); $('#scrim').hidden = !(open && isPhone()); }
$('#dockBtn').onclick = () => setDock(!document.body.classList.contains('dock-open'));
$('#scrim').onclick = () => setDock(false);
$('#decideBtn').onclick = () => {
  const d = design(); if (!d) return;
  const open = d.proposals.filter(p => p.status === 'open');
  if (open.length === 1) select({ kind: 'proposal', id: open[0].id }); else setDock(true);
};
$('#moreBtn').onclick = (e) => { e.stopPropagation(); $('#moreMenu').hidden = !$('#moreMenu').hidden; };
document.addEventListener('click', () => { $('#moreMenu').hidden = true; });
$('#moreMenu').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $('#moreMenu').hidden = true;
  if (b.dataset.m === 'undo') undo();
  else if (b.dataset.m === 'share') shareModal();
  else if (b.dataset.m === 'approve') $('#approveBtn').onclick();
  else if (b.dataset.fmt) { try { copy(await api(D(`/export?format=${b.dataset.fmt}`))); } catch (er) { toast(er.message, true); } }
};
phoneQuery.addEventListener('change', () => { if (!isPhone()) { closeSheet(); setDock(false); } });
// Safari: keep the page itself from zooming or rubber-banding; the canvas handles gestures
document.addEventListener('gesturestart', (e) => e.preventDefault());
