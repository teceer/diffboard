/* diffboard UI: graph of changed files (+ import neighbours and notes), diff / file viewer with
   line references, notes with markdown and mermaid. State comes from /api/state, pushed via SSE. */
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const base = p => p.split('/').pop();
  const time = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ago = ts => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : time(ts); };
  const api = async (path, init) => { const r = await fetch(path, init); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || r.statusText); return b; };
  const post = (path, body, method = 'POST') => api(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  let toastTimer;
  const toast = msg => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 1800); };
  async function copy(text, label = 'Copied') {
    try { await navigator.clipboard.writeText(text); toast(`${label}: ${text.length > 70 ? text.slice(0, 67) + '…' : text}`); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(label); }
  }

  const S = {
    data: null, cy: null, topology: '', filter: '', neighbours: true,
    open: null,            // { kind: 'file', repo, path } | { kind: 'note', id }
    view: 'diff', layout: 'unified', fullDiff: true,
    diff: null, content: null, openSig: '',
    sel: null,             // { side: 'new'|'old', start, end }
    editing: false, lastFile: null, fedit: null,
    expanded: new Set(), cardCache: new Map(),   // node id -> { sig, html }
    cardLayout: 'unified', cardLayouts: new Map(), // global default + per-card override
    tour: '', rvIdx: -1, reviewOpen: false,         // review order: chosen tour, current item, sidebar
    board: 'default', boards: [], boardsOpen: true,   // independent boards, one per agent session
    dockTab: 'boards', files: null, treeOpen: new Set(), treeFilter: '', // file tree of the board's repos
  };
  try { S.dockTab = localStorage.getItem('diffboard.dockTab') || 'boards'; } catch {}
  try { S.board = new URLSearchParams(location.hash.slice(1)).get('board') || localStorage.getItem('diffboard.board') || 'default'; S.boardsOpen = localStorage.getItem('diffboard.boardsOpen') !== '0'; } catch {}
  /* every board-scoped call goes through the open board */
  const B = () => `/api/b/${encodeURIComponent(S.board)}`;
  try { S.fullDiff = localStorage.getItem('diffboard.fullDiff') !== '0'; } catch {}
  try { S.tour = localStorage.getItem('diffboard.tour') || ''; S.reviewOpen = localStorage.getItem('diffboard.reviewOpen') === '1'; } catch {}
  try { S.cardLayout = localStorage.getItem('diffboard.cardLayout') || 'unified'; for (const [k, v] of JSON.parse(localStorage.getItem('diffboard.cardLayouts') || '[]')) S.cardLayouts.set(k, v); } catch {}
  try { for (const id of JSON.parse(localStorage.getItem('diffboard.expanded') || '[]')) S.expanded.add(id); } catch {}
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });

  /* ---------------- graph ---------------- */
  const statusColor = s => ({ A: css('--add'), U: css('--add'), M: css('--mod'), D: css('--del'), R: css('--ren'), N: css('--nb') }[s] || css('--nb'));
  function initGraph() {
    S.cy = window.__cy = cytoscape({
      container: $('#cy'), wheelSensitivity: 0.25, minZoom: 0.05, maxZoom: 2.5,
      style: [
        { selector: 'node.repo', style: { 'background-color': css('--accent'), 'background-opacity': 0.035, 'border-color': css('--line'), 'border-width': 1, 'border-style': 'dashed', label: 'data(label)', 'text-valign': 'top', 'text-halign': 'center', 'font-size': 12, 'font-weight': 600, color: css('--muted'), padding: 18, shape: 'round-rectangle' } },
        { selector: 'node.file', style: { shape: 'round-rectangle', 'background-color': css('--surface'), 'border-width': 2, 'border-color': 'data(color)', label: 'data(label)', 'text-wrap': 'wrap', 'text-valign': 'center', 'font-size': 13, 'font-family': css('--mono'), color: css('--fg'), width: 'label', height: 'label', padding: 10 } },
        { selector: 'node.file.reviewed', style: { 'background-color': css('--add-bg') } },
        { selector: 'node.file.N', style: { 'border-style': 'dashed', 'border-width': 1.5, color: css('--muted'), 'font-size': 12 } },
        { selector: 'node.note', style: { shape: 'round-rectangle', 'background-color': css('--note-bg'), 'border-color': css('--note'), 'border-width': 2, label: 'data(label)', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 200, 'font-size': 13, color: css('--fg'), width: 'label', height: 'label', padding: 8 } },
        { selector: 'node.file.expanded', style: { width: 'data(cardW)', height: 'data(cardH)', label: '', 'background-opacity': 0, 'border-width': 0, padding: 0 } },
        { selector: 'node.recent', style: { 'underlay-color': css('--add'), 'underlay-padding': 7, 'underlay-opacity': 0.28, 'underlay-shape': 'round-rectangle' } },
        { selector: 'node:selected', style: { 'border-color': css('--accent'), 'border-width': 3 } },
        { selector: 'node.dim', style: { opacity: 0.25 } },
        { selector: 'edge', style: { width: 1.3, 'line-color': css('--nb'), 'target-arrow-color': css('--nb'), 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'curve-style': 'bezier', opacity: 0.8 } },
        { selector: 'edge.link', style: { 'line-style': 'dashed', 'line-color': css('--note'), 'target-arrow-shape': 'none', width: 1.5 } },
        { selector: 'edge.hl', style: { 'line-color': css('--accent'), 'target-arrow-color': css('--accent'), width: 2, opacity: 1 } },
        { selector: '.faded', style: { opacity: 0.16 } },
        { selector: 'node.dep-out', style: { 'border-color': css('--accent'), 'border-width': 3 } },
        { selector: 'node.dep-in', style: { 'border-color': '#a855f7', 'border-width': 3 } },
        { selector: 'edge.dep-out', style: { 'line-color': css('--accent'), 'target-arrow-color': css('--accent'), width: 2.4, opacity: 1, 'z-index': 10 } },
        { selector: 'edge.dep-in', style: { 'line-color': '#a855f7', 'target-arrow-color': '#a855f7', width: 2.4, opacity: 1, 'z-index': 10 } },
        { selector: 'node.focus', style: { 'border-color': css('--accent'), 'border-width': 4 } },
        { selector: '.far', style: { opacity: 0.45 } },
        { selector: 'edge.far', style: { width: 1.4 } },
        { selector: 'node.dir', style: { shape: 'round-rectangle', 'background-color': css('--surface'), 'border-width': 1.5, 'border-color': css('--line'), label: 'data(label)', 'text-wrap': 'wrap', 'text-valign': 'center', 'font-size': 13, 'font-family': css('--sans'), color: css('--fg'), width: 'label', height: 'label', padding: 12 } },
        { selector: 'node.dir.changed', style: { 'border-color': css('--mod'), 'border-width': 2.5 } },
        { selector: 'edge.agg', style: { width: 'data(w)' } },
        { selector: 'node.refhit', style: { 'underlay-color': css('--accent'), 'underlay-padding': 8, 'underlay-opacity': 0.35, 'underlay-shape': 'round-rectangle' } },
        { selector: '.hidden', style: { display: 'none' } },
      ],
    });
    S.cy.on('tap', 'node.file', e => openFile(e.target.data('repo'), e.target.data('path')));
    S.cy.on('tap', 'node.dir', e => toggleDir(`${e.target.data('repo')}:${e.target.data('path')}`, true));
    S.cy.on('tap', 'node.note', e => openNote(e.target.data('noteId')));
    S.cy.on('dbltap', 'node.file', e => toggleCard(e.target.id()));
    S.cy.on('viewport resize', syncCards);
    S.cy.on('position', 'node', syncCards);
    S.cy.on('tap', e => { if (e.target === S.cy) { S.focusOff = true; applyFocus(); } });
    S.cy.on('cxttap', e => graphMenu(e.target, e.originalEvent));
    S.cy.on('mouseover', 'node.file, node.note', e => e.target.connectedEdges().addClass('hl'));
    S.cy.on('mouseout', 'node', e => e.target.connectedEdges().removeClass('hl'));
  }

  const fileLabel = n => {
    const dir = n.path.split('/').slice(0, -1).slice(-2).join('/');
    const stat = n.status === 'N' ? '' : n.binary ? '  bin' : `  +${n.add} −${n.del}`;
    return `${base(n.path)}${stat}\n${dir}`;
  };

  async function syncGraph(data) {
    const cy = S.cy;
    const want = S.graphMode === 'map' ? await mapWant(data) : changesWant(data);
    if (!want) return;
    if (S.graphMode === 'map') data = { ...data, topology: [...want.keys()].join('|').length + ':' + want.size + ':' + S.mapKey };
    await drawGraph(data, want);
  }

  /* changes mode: changed files, their import neighbours, notes */
  function changesWant(data) {
    const want = new Map();
    for (const r of data.repos) want.set(`repo:${r.id}`, { group: 'nodes', data: { id: `repo:${r.id}`, label: `${r.id} · ${r.branch ?? ''}` }, classes: 'repo' });
    const now = Date.now();
    const done = new Set(data.review?.reviewed ?? []);
    for (const n of data.nodes) want.set(n.id, { group: 'nodes', data: { id: n.id, parent: `repo:${n.repo}`, repo: n.repo, path: n.path, status: n.status, color: statusColor(n.status), label: (done.has(n.id) ? '✓ ' : '') + fileLabel(n) }, classes: `file ${n.status}${done.has(n.id) ? ' reviewed' : ''}${n.changedAt && now - n.changedAt < 12000 ? ' recent' : ''}${S.expanded.has(n.id) && n.status !== 'N' && !n.binary ? ' expanded' : ''}` });
    for (const note of data.notes) {
      want.set(`note:${note.id}`, { group: 'nodes', data: { id: `note:${note.id}`, noteId: note.id, label: `✎ ${note.title}` }, classes: 'note' });
      note.links.forEach((l, i) => { if (l.repo) want.set(`nl:${note.id}:${i}`, { group: 'edges', data: { id: `nl:${note.id}:${i}`, source: `note:${note.id}`, target: `${l.repo}:${l.path}` }, classes: 'link' }); });
    }
    for (const e of data.edges) want.set(`e:${e.from}>${e.to}`, { group: 'edges', data: { id: `e:${e.from}>${e.to}`, source: e.from, target: e.to } });
    return want;
  }

  async function drawGraph(data, want) {
    const cy = S.cy;
    cy.batch(() => {
      cy.elements().forEach(el => { if (!want.has(el.id())) el.remove(); });
      for (const [id, def] of want) {
        const el = cy.getElementById(id);
        if (el.nonempty()) { el.data(def.data); el.classes(def.classes || ''); }
        else if (def.group === 'nodes' || (cy.getElementById(def.data.source).nonempty() || want.has(def.data.source))) cy.add(def);
      }
      // edges whose endpoints were added after them
      for (const [id, def] of want) if (def.group === 'edges' && cy.getElementById(id).empty() && cy.getElementById(def.data.source).nonempty() && cy.getElementById(def.data.target).nonempty()) cy.add(def);
    });
    applyFilter();
    const sizesChanged = await renderCards(data);
    if (data.topology !== S.topology || sizesChanged) { S.topology = data.topology; layout(!S.laidOut); S.laidOut = true; }
    syncCards();
    if (S.open?.kind === 'file') cy.$(`[id = "${S.open.repo}:${S.open.path}"]`).select();
    $('#empty').hidden = data.nodes.length > 0 || data.notes.length > 0 || S.graphMode === 'map';
    const big = data.repos.filter(r => r.tooMany);
    if (big.length && S.graphMode !== 'map') $('#empty').hidden = data.nodes.length > 0;
    $('#empty').innerHTML = big.length
      ? big.map(r => `<b>${esc(r.id)}</b> has ${r.tooMany} changed files against <code>${esc(r.base)}</code>, too many to draw.`).join('<br>') + '<br>Usually the base is wrong: click the base in the title bar and pick the branch this work started from.'
      : data.repos.length ? 'No changes against the base yet.<br>Edit a file in a watched repo and it shows up here.' : 'No repositories watched.<br><code>diffboard add &lt;path&gt;</code>';
  }

  /* ---------------- whole-repo map: folders that unfold into subfolders and files ---------------- */
  const MAP_MAX = 450; // nodes on screen before an unfold is refused
  S.graphMode = 'changes'; S.map = null; S.mapOpen = new Set(); S.mapKey = 0;
  try { S.graphMode = localStorage.getItem('diffboard.graphMode') === 'map' ? 'map' : 'changes'; } catch {}

  async function loadMap(force) {
    if (S.map && S.map.board === S.board && !force && Date.now() - S.map.at < 15000) return S.map;
    const r = await api(`${B()}/map`);
    // a folder tree per repo; every file keeps its global index for the edges
    const trees = r.repos.map(() => ({ dirs: new Map(), files: [] }));
    r.files.forEach(([ri, path], i) => {
      const parts = path.split('/');
      let d = trees[ri];
      for (let k = 0; k < parts.length - 1; k++) { if (!d.dirs.has(parts[k])) d.dirs.set(parts[k], { dirs: new Map(), files: [] }); d = d.dirs.get(parts[k]); }
      d.files.push(i);
    });
    const count = d => { d.n = d.files.length; for (const s of d.dirs.values()) d.n += count(s); return d.n; };
    trees.forEach(count);
    S.map = { board: S.board, at: Date.now(), repos: r.repos, files: r.files, edges: r.edges, trees };
    return S.map;
  }

  /** Graph elements for the current unfold state: one node per folded folder or visible file. */
  async function mapWant(data) {
    let m;
    try { m = await loadMap(); } catch (err) { toast(err.message); return null; }
    if (S.graphMode !== 'map') return null;
    const want = new Map();
    const unitOf = new Array(m.files.length);
    const changed = new Map(data.nodes.filter(n => n.status !== 'N').map(n => [n.id, n]));
    const done = new Set(data.review?.reviewed ?? []);
    const many = m.repos.length > 1;
    const fileUnit = (ri, i) => {
      const repo = m.repos[ri], path = m.files[i][1], id = `${repo}:${path}`, n = changed.get(id) ?? { id, repo, path, status: 'N', add: 0, del: 0 };
      want.set(id, { group: 'nodes', data: { id, parent: `repo:${repo}`, repo, path, status: n.status, color: statusColor(n.status), label: (done.has(id) ? '✓ ' : '') + fileLabel(n) }, classes: `file ${n.status}${done.has(id) ? ' reviewed' : ''}${S.expanded.has(id) && expandable(n) ? ' expanded' : ''}` });
      unitOf[i] = id;
    };
    const assign = (d, id) => { for (const i of d.files) unitOf[i] = id; for (const s of d.dirs.values()) assign(s, id); };
    const walk = (ri, d, prefix) => {
      const repo = m.repos[ri];
      for (const [name, sub] of d.dirs) {
        // a folder holding only one folder folds into it: "packages/db/src" is one step
        let path = prefix + name, node = sub;
        while (node.files.length === 0 && node.dirs.size === 1) { const [n2, s2] = [...node.dirs][0]; path += '/' + n2; node = s2; }
        const key = `${repo}:${path}`;
        if (S.mapOpen.has(key)) { walk(ri, node, path + '/'); continue; }
        const id = `dir:${key}`;
        let nChanged = 0, add = 0, del = 0;
        for (const [cid, n] of changed) if (n.repo === repo && cid.startsWith(`${repo}:${path}/`)) { nChanged++; add += n.add; del += n.del; }
        want.set(id, { group: 'nodes', data: { id, parent: `repo:${repo}`, repo, path, dir: true, label: `▸ ${path.split('/').slice(-2).join('/')}/\n${node.n} file${node.n === 1 ? '' : 's'}${nChanged ? ` · ${nChanged} changed +${add} −${del}` : ''}` }, classes: `dir${nChanged ? ' changed' : ''}` });
        assign(node, id);
      }
      for (const i of d.files) fileUnit(ri, i);
    };
    m.trees.forEach((t, ri) => {
      const r = data.repos.find(x => x.id === m.repos[ri]);
      want.set(`repo:${m.repos[ri]}`, { group: 'nodes', data: { id: `repo:${m.repos[ri]}`, label: `${m.repos[ri]} · ${r?.branch ?? ''}` }, classes: 'repo' });
      walk(ri, t, '');
    });
    // import edges folded onto the visible units, with how many file imports each one stands for
    const agg = new Map();
    for (const [a, b] of m.edges) {
      const ua = unitOf[a], ub = unitOf[b];
      if (!ua || !ub || ua === ub) continue;
      const k = `${ua}>${ub}`;
      agg.set(k, (agg.get(k) ?? 0) + 1);
    }
    for (const [k, n] of agg) {
      const [source, target] = k.split('>');
      want.set(`e:${k}`, { group: 'edges', data: { id: `e:${k}`, source, target, weight: n, w: Math.min(6, 1 + Math.log2(n)) }, classes: n > 1 ? 'agg' : '' });
    }
    for (const note of data.notes) {
      want.set(`note:${note.id}`, { group: 'nodes', data: { id: `note:${note.id}`, noteId: note.id, label: `✎ ${note.title}` }, classes: 'note' });
      note.links.forEach((l, i) => { const t = l.repo && (want.has(`${l.repo}:${l.path}`) ? `${l.repo}:${l.path}` : unitOf[m.files.findIndex(f => m.repos[f[0]] === l.repo && f[1] === l.path)]); if (t) want.set(`nl:${note.id}:${i}`, { group: 'edges', data: { id: `nl:${note.id}:${i}`, source: `note:${note.id}`, target: t }, classes: 'link' }); });
    }
    if (many) for (const id of m.repos) S.mapOpen.add(`${id}:`);
    return want;
  }

  const mapNodeCount = () => S.cy.nodes().not('.repo').length;
  async function toggleDir(key, open) {
    const was = S.mapOpen.has(key);
    open = open ?? !was;
    if (open === was) return;
    open ? S.mapOpen.add(key) : S.mapOpen.delete(key);
    S.mapKey++;
    await syncGraph(S.data);
    if (open && mapNodeCount() > MAP_MAX) {
      S.mapOpen.delete(key); S.mapKey++;
      await syncGraph(S.data);
      toast(`Unfolding ${key.split(':').slice(1).join(':')} would draw more than ${MAP_MAX} nodes. Fold something else first.`);
    }
  }
  /** Unfolds the folders down to a file (when opened from elsewhere), within the node limit. */
  async function revealOnMap(repo, path) {
    if (S.graphMode !== 'map' || !S.map) return;
    if (S.cy.getElementById(`${repo}:${path}`).nonempty()) return;
    const parts = path.split('/');
    const added = [];
    for (let i = 1; i < parts.length; i++) { const k = `${repo}:${parts.slice(0, i).join('/')}`; if (!S.mapOpen.has(k)) { S.mapOpen.add(k); added.push(k); } }
    if (!added.length) return;
    S.mapKey++;
    await syncGraph(S.data);
    if (mapNodeCount() > MAP_MAX) { added.forEach(k => S.mapOpen.delete(k)); S.mapKey++; await syncGraph(S.data); }
    S.cy.$(':selected').unselect(); S.cy.getElementById(`${repo}:${path}`).select();
    applyFocus(true);
  }

  function setGraphMode(mode) {
    S.graphMode = mode;
    try { localStorage.setItem('diffboard.graphMode', mode); } catch {}
    document.querySelectorAll('#graphMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.graph === mode)));
    $('#showNeighbours').closest('label').hidden = mode === 'map';
    S.topology = ''; S.laidOut = false;
    S.cy.elements().remove();
    if (S.data) syncGraph(S.data).then(() => { applyFocus(); if (S.open?.kind === 'file') revealOnMap(S.open.repo, S.open.path); });
  }
  $('#graphMode').addEventListener('click', e => { const b = e.target.closest('[data-graph]'); if (b) setGraphMode(b.dataset.graph); });

  /* ---------------- inline diff cards ---------------- */
  const CARD_W = { unified: 560, split: 960 };
  const CARD_MAX_W = 2400;
  const layoutOf = id => S.cardLayouts.get(id) ?? S.cardLayout;
  function persistLayouts() { try { localStorage.setItem('diffboard.cardLayout', S.cardLayout); localStorage.setItem('diffboard.cardLayouts', JSON.stringify([...S.cardLayouts])); } catch {} }
  const expandable = n => n && n.status !== 'N' && !n.binary;
  function persistExpanded() { try { localStorage.setItem('diffboard.expanded', JSON.stringify([...S.expanded])); } catch {} }

  async function cardHtml(n) {
    const lay = layoutOf(n.id);
    const sig = sigOf(n) + '|' + lay;
    const hit = S.cardCache.get(n.id);
    if (hit && hit.sig === sig) return hit.html;
    const { diff } = await api(`${B()}/diff?repo=${encodeURIComponent(n.repo)}&path=${encodeURIComponent(n.path)}`).catch(() => ({ diff: '' }));
    const hunks = parseDiff(diff);
    const body = hunks.length ? (lay === 'split' ? renderSplit(hunks, langOf(n.path)) : renderUnified(hunks, langOf(n.path))) : '<div class="msg">No textual changes.</div>';
    const dir = n.path.split('/').slice(0, -1).join('/');
    const html = `<div class="ch" data-card-open="1"><span class="badge ${n.status}">${n.status}</span><span class="nm">${esc(base(n.path))}</span><span class="dir">${esc(dir)}</span><span class="stat"><span class="p">+${n.add}</span> <span class="m">−${n.del}</span></span><button data-card-toggle-layout="1" title="${lay === 'split' ? 'Show unified' : 'Show side by side'}">${lay === 'split' ? 'Unified' : 'Split'}</button><button data-card-collapse="1" title="Collapse to a node">−</button></div><div class="cb">${body}</div>`;
    S.cardCache.set(n.id, { sig, html });
    return html;
  }

  /** Renders a card per expanded node, measures it at scale 1 and gives the graph node that size. */
  async function renderCards(data) {
    const layer = $('#cards');
    const want = data.nodes.filter(n => S.expanded.has(n.id) && expandable(n));
    const ids = new Set(want.map(n => n.id));
    layer.querySelectorAll('.card').forEach(c => { if (!ids.has(c.dataset.id)) c.remove(); });
    let changed = false;
    for (const n of want) {
      let card = layer.querySelector(`.card[data-id="${CSS.escape(n.id)}"]`);
      if (!card) { card = document.createElement('div'); card.className = 'card'; card.dataset.id = n.id; layer.append(card); changed = true; }
      card.className = `card st-${n.status}${layoutOf(n.id) === 'split' ? ' split' : ''}${data.review?.reviewed.includes(n.id) ? ' reviewed' : ''}${S.open?.kind === 'file' && `${S.open.repo}:${S.open.path}` === n.id ? ' active' : ''}`;
      const html = await cardHtml(n);
      const csig = sigOf(n) + '|' + layoutOf(n.id);
      if (card.dataset.sig !== csig) { const keep = card.querySelector('.cb')?.scrollTop ?? 0; card.innerHTML = html; card.dataset.sig = csig; card.querySelector('.cb').scrollTop = keep; }
      card.style.transform = 'none';
      // natural width of the code, so no line is cut; past the cap, wrap instead
      card.classList.remove('wrap');
      card.style.width = 'max-content';
      const natural = Math.ceil(card.offsetWidth);
      const w = Math.max(CARD_W[layoutOf(n.id)], Math.min(natural, CARD_MAX_W));
      if (natural > CARD_MAX_W) card.classList.add('wrap');
      card.style.width = `${w}px`;
      const h = Math.ceil(card.offsetHeight);
      const node = S.cy.getElementById(n.id);
      if (node.nonempty() && (node.data('cardW') !== w || node.data('cardH') !== h)) { node.data({ cardW: w, cardH: h }); changed = true; }
      node.addClass('expanded');
    }
    S.cy.nodes('.file').forEach(nd => { if (!ids.has(nd.id()) && nd.hasClass('expanded')) { nd.removeClass('expanded'); changed = true; } });
    applyFocus();
    return changed;
  }

  function syncCards() {
    if (!S.cy) return;
    const z = S.cy.zoom();
    $('#cards').querySelectorAll('.card').forEach(card => {
      const node = S.cy.getElementById(card.dataset.id);
      if (node.empty() || node.hasClass('hidden')) { card.style.display = 'none'; return; }
      card.style.display = '';
      const p = node.renderedPosition();
      card.style.transform = `translate(${p.x - (node.data('cardW') * z) / 2}px, ${p.y - (node.data('cardH') * z) / 2}px) scale(${z})`;
    });
  }

  async function toggleCard(id, force) {
    const n = S.data.nodes.find(x => x.id === id);
    if (!expandable(n)) return;
    const on = force ?? !S.expanded.has(id);
    on ? S.expanded.add(id) : S.expanded.delete(id);
    persistExpanded();
    if (await renderCards(S.data)) layout(false);
    syncCards();
  }

  /* wheel over a card's diff only scrolls it (pinch / ctrl zooms the graph); elsewhere on a card it zooms */
  $('#cards').addEventListener('wheel', e => {
    if (e.target.closest('.cb') && !e.ctrlKey) return;
    e.preventDefault();
    const rect = $('#cy').getBoundingClientRect();
    const z = Math.min(2.5, Math.max(0.15, S.cy.zoom() * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
    S.cy.zoom({ level: z, renderedPosition: { x: e.clientX - rect.left, y: e.clientY - rect.top } });
  }, { passive: false });

  function renderCardLayoutSeg() { document.querySelectorAll('#cardLayout button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cardLayout === S.cardLayout))); }
  renderCardLayoutSeg();
  $('#cardLayout').addEventListener('click', async e => {
    const b = e.target.closest('[data-card-layout]'); if (!b) return;
    S.cardLayout = b.dataset.cardLayout; S.cardLayouts.clear(); persistLayouts(); renderCardLayoutSeg();
    if (S.expanded.size === 0) for (const n of S.data.nodes) if (expandable(n)) S.expanded.add(n.id);
    persistExpanded();
    if (await renderCards(S.data)) layout(true);
    syncCards();
  });

  $('#expandAll').addEventListener('click', async () => {
    for (const n of S.data.nodes) if (expandable(n)) S.expanded.add(n.id);
    persistExpanded(); await renderCards(S.data); layout(true); syncCards();
  });
  $('#collapseAll').addEventListener('click', async () => {
    S.expanded.clear(); persistExpanded(); await renderCards(S.data); layout(true); syncCards();
  });
  $('#cards').addEventListener('click', e => {
    const card = e.target.closest('.card'); if (!card) return;
    const n = S.data.nodes.find(x => x.id === card.dataset.id); if (!n) return;
    if (e.target.closest('[data-card-collapse]')) return toggleCard(n.id, false);
    if (e.target.closest('[data-card-toggle-layout]')) {
      const next = layoutOf(n.id) === 'split' ? 'unified' : 'split';
      next === S.cardLayout ? S.cardLayouts.delete(n.id) : S.cardLayouts.set(n.id, next);
      persistLayouts();
      return renderCards(S.data).then(ch => { if (ch) layout(false); syncCards(); });
    }
    const cell = e.target.closest('td[data-side][data-n]');
    if (cell && cell.dataset.n) return openFile(n.repo, n.path, { view: 'diff', side: cell.dataset.side, lines: [Number(cell.dataset.n), Number(cell.dataset.n)] });
    if (e.target.closest('[data-card-open]')) return openFile(n.repo, n.path);
  });

  /* highlight everything the open file depends on (blue) and everything that uses it (violet) */
  function applyFocus(zoomTo = false) {
    const cy = S.cy;
    if (!cy) return;
    cy.elements().removeClass('faded focus dep-out dep-in far');
    const cards = [...document.querySelectorAll('#cards .card')];
    cards.forEach(c => c.classList.remove('faded', 'dep-out', 'dep-in'));
    $('.legend').classList.remove('focused');
    if (S.focusOff || !S.open) return;
    const id = S.open.kind === 'file' ? `${S.open.repo}:${S.open.path}` : `note:${S.open.id}`;
    const node = cy.getElementById(id);
    if (node.empty()) return;
    const isNote = S.open.kind === 'note';
    // direct imports / importers are highlighted; transitive ones stay visible but muted
    const notLink = el => !el.hasClass('link');
    const imports = isNote ? node.outgoers() : node.outgoers().filter(notLink);
    const users = isNote ? cy.collection() : node.incomers().filter(notLink);
    const farImports = isNote ? cy.collection() : node.successors().filter(notLink).difference(imports);
    const farUsers = isNote ? cy.collection() : node.predecessors().filter(notLink).difference(users);
    const keep = node.union(imports).union(users);
    cy.batch(() => {
      cy.elements().not(keep).not(farImports).not(farUsers).not('.repo').addClass('faded');
      imports.union(farImports).addClass('dep-out');
      users.union(farUsers).addClass('dep-in');
      farImports.union(farUsers).addClass('far');
      node.addClass('focus');
    });
    for (const c of cards) {
      const n = cy.getElementById(c.dataset.id);
      if (n.hasClass('faded') || n.hasClass('far')) c.classList.add('faded');
      else if (n.hasClass('dep-out')) c.classList.add('dep-out');
      else if (n.hasClass('dep-in')) c.classList.add('dep-in');
    }
    $('.legend').classList.toggle('focused', !isNote);
    if (zoomTo) glideTo(node, keep.filter(el => !el.hasClass('hidden')));
  }

  /* one continuous move to the focused file: keep the current zoom whenever it is readable and the
     dependencies fit, otherwise ease towards the fitting zoom - never zoom out and back in */
  let glide = 0;
  function glideTo(node, vis) {
    const cy = S.cy;
    const W = cy.width(), H = cy.height(), pad = 80;
    const bb = vis.boundingBox();
    const fitZ = Math.min((W - 2 * pad) / Math.max(bb.w, 1), (H - 2 * pad) / Math.max(bb.h, 1));
    const z0 = cy.zoom();
    // stay readable: between 55 % and 120 %
    const z1 = Math.min(1.2, Math.max(0.55, z0 <= fitZ && z0 >= 0.55 && z0 <= 1.2 ? z0 : fitZ));
    // centre on the dependencies when they fit, otherwise on the file itself
    const p = node.position();
    const c1 = z1 <= fitZ ? { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 } : p;
    const pan0 = cy.pan();
    const c0 = { x: (W / 2 - pan0.x) / z0, y: (H / 2 - pan0.y) / z0 };
    const dist = Math.hypot((c1.x - c0.x) * z1, (c1.y - c0.y) * z1);
    const dur = Math.min(650, 280 + dist * 0.25);
    const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const id = ++glide, t0 = performance.now();
    cy.stop(true);
    const step = now => {
      if (id !== glide) return;
      const t = Math.min(1, (now - t0) / dur), k = ease(t);
      // zoom interpolated geometrically and the centre in graph space, so the path is a straight glide
      const z = z0 * (z1 / z0) ** k;
      const c = { x: c0.x + (c1.x - c0.x) * k, y: c0.y + (c1.y - c0.y) * k };
      cy.viewport({ zoom: z, pan: { x: W / 2 - c.x * z, y: H / 2 - c.y * z } });
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // the user grabbing or zooming the board takes over from a running glide
  ['wheel', 'mousedown', 'touchstart'].forEach(ev => {
    $('#cy').addEventListener(ev, () => { glide++; }, { capture: true, passive: true });
    $('#cards').addEventListener(ev, () => { glide++; }, { capture: true, passive: true });
  });

  function layout(fit) {
    S.cy.resize();
    const vis = S.cy.elements().not('.hidden');
    const l = vis.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 18, rankSep: 70, edgeSep: 8, fit: false, animate: !fit, animationDuration: 250 });
    if (fit) l.one('layoutstop', () => {
      S.cy.fit(vis, 60);
      if (S.cy.zoom() > 1.3) { S.cy.zoom(1.3); S.cy.center(vis); }
      // with diff cards open, keep code readable: no smaller than 80 %, start at the top-left of the graph
      if (S.expanded.size && S.cy.zoom() < 0.8) {
        const bb = vis.boundingBox();
        S.cy.zoom(0.8);
        S.cy.pan({ x: 40 - bb.x1 * 0.8, y: 70 - bb.y1 * 0.8 });
      }
    });
    l.run();
  }

  function applyFilter() {
    const f = S.filter.toLowerCase();
    S.cy.batch(() => {
      S.cy.nodes('.file').forEach(n => {
        const hide = (S.graphMode !== 'map' && !S.neighbours && n.data('status') === 'N' && n.connectedEdges('.link').empty()) || (f && !n.data('path').toLowerCase().includes(f));
        n.toggleClass('hidden', !!hide);
      });
      S.cy.nodes('.repo').forEach(r => r.toggleClass('hidden', r.children().not('.hidden').empty()));
    });
  }

  /* ---------------- status bar ---------------- */
  function renderStatus(data) {
    const files = data.repos.reduce((s, r) => s + r.files, 0);
    $('#sbBoard').textContent = S.boards.find(b => b.id === S.board)?.name ?? S.board;
    $('#sbStats').innerHTML = `${data.repos.length} repo${data.repos.length === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'} · ${data.notes.length} note${data.notes.length === 1 ? '' : 's'}`;
    $('#sbMode').textContent = data.mode === 'head' ? 'since last commit' : 'whole branch';
  }

  /* ---------------- top bar ---------------- */
  function renderTop(data) {
    $('#repos').innerHTML = data.repos.map(r => `<span class="repo" data-repo="${esc(r.id)}" title="${esc(r.path)}"><b>${esc(r.id)}</b> ${esc(r.branch ?? '')}
      <span class="base" data-pick-base="${esc(r.id)}" title="Diffed against the merge-base with this ref (${esc(r.baseSource)}). Click to change.">base: ${esc(r.base ?? '?')}${r.baseSource === 'auto' ? ' (auto)' : ''}</span>
      <span class="stat">${r.files} files <span class="p">+${r.add}</span> <span class="m">−${r.del}</span></span>${r.error ? `<span class="err" title="${esc(r.error)}">error</span>` : ''}${r.tooMany ? `<span class="err" data-pick-base="${esc(r.id)}" title="Too many changed files to draw. Click to pick another base.">not drawn: too many files</span>` : ''}</span>`).join('');
    document.querySelectorAll('#mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === data.mode)));
  }

  $('#repos').addEventListener('click', async e => {
    const t = e.target.closest('[data-pick-base]');
    if (!t) return;
    const repo = t.dataset.pickBase;
    const { branches } = await api(`${B()}/branches?repo=${encodeURIComponent(repo)}`);
    const cur = S.data.repos.find(r => r.id === repo);
    const sel = document.createElement('select');
    sel.innerHTML = `<option value="">auto (closest RC / develop / main)</option>` + branches.map(b => `<option ${cur?.configuredBase === b ? 'selected' : ''}>${esc(b)}</option>`).join('');
    t.replaceWith(sel);
    sel.focus();
    sel.addEventListener('change', async () => { await post(`${B()}/base`, { repo, base: sel.value }); toast(`base: ${sel.value || 'auto'}`); });
    sel.addEventListener('blur', () => renderTop(S.data));
  });
  $('#mode').addEventListener('click', async e => { const b = e.target.closest('[data-mode]'); if (b) await post(`${B()}/mode`, { mode: b.dataset.mode }); });
  $('#filter').addEventListener('input', e => { S.filter = e.target.value; applyFilter(); });
  $('#showNeighbours').addEventListener('change', e => { S.neighbours = e.target.checked; applyFilter(); layout(false); });
  $('#relayout').addEventListener('click', () => layout(true));
  $('#newNote').addEventListener('click', () => createNote({ title: 'New note', links: S.open?.kind === 'file' ? [`${S.open.repo}:${S.open.path}`] : [] }));

  /* ---------------- boards ---------------- */
  const LIVE_MS = 15000;
  async function loadBoards() {
    const { boards } = await api('/api/boards');
    S.boards = boards;
    if (!boards.some(b => b.id === S.board)) return switchBoard('default');
    renderBoards();
  }

  function renderBoards() {
    const now = Date.now();
    $('#boardList').innerHTML = S.boards.map(b => {
      const live = b.lastAt && now - b.lastAt < LIVE_MS;
      const repos = b.repos.map(r => `${esc(r.id)}${r.branch ? `<span class="br">${esc(r.branch)}</span>` : ''}`).join(' ') || '<span class="meta">no repos</span>';
      return `<li class="bd${b.id === S.board ? ' cur' : ''}${live ? ' live' : ''}" data-board="${esc(b.id)}" title="${esc(b.lastText ?? b.name)}">
        <div class="bdrow"><i class="pulse"></i><b class="bdname">${esc(b.name)}</b><span class="spacer"></span>
          <span class="stat">${b.files ? `<span class="p">+${b.add}</span> <span class="m">−${b.del}</span>` : ''}</span>
          <span class="bdacts"><button class="ib" data-board-act="rename" title="Rename" aria-label="Rename board">✎</button>${b.id === 'default' ? '' : '<button class="ib" data-board-act="rm" title="Archive board" aria-label="Archive board">✕</button>'}</span></div>
        <div class="bdrepos">${repos}</div>
        ${b.lastAt ? `<div class="bdlast"><time>${ago(b.lastAt)}</time> ${esc(b.lastText)}</div>` : ''}
      </li>`;
    }).join('');
    const cur = S.boards.find(b => b.id === S.board);
    $('#boardName').textContent = cur?.name ?? S.board;
    document.title = `${cur?.name ?? S.board} · diffboard`;
  }

  async function switchBoard(id, fromNav = false) {
    if (id === S.board && S.data) return;
    if (!fromNav) rememberScroll();
    if (S.fedit) await endEdit(false);
    S.board = id;
    try { localStorage.setItem('diffboard.board', id); } catch {}
    S.open = null; S.sel = null; S.editing = false; S.tour = ''; S.rvIdx = -1;
    S.topology = ''; S.laidOut = false; S.cardCache.clear(); S.files = null; S.treeOpen.clear(); S.map = null; S.mapOpen.clear();
    S.cy.elements().remove();
    $('#cards').innerHTML = '';
    $('#fileView').hidden = true; $('#noteView').hidden = true; $('#placeholder').hidden = false;
    paintSel();
    setHash(!fromNav);
    renderBoards();
    await refresh();
  }

  function setBoardsOpen(open) {
    S.boardsOpen = open;
    $('#boards').hidden = !open;
    if (open && S.dockTab === 'files') renderTree();
    $('#boardsToggle').setAttribute('aria-pressed', String(open));
    try { localStorage.setItem('diffboard.boardsOpen', open ? '1' : '0'); } catch {}
    requestAnimationFrame(() => { S.cy?.resize(); syncCards(); paintSel(); });
  }

  $('#boardsToggle').addEventListener('click', () => setBoardsOpen(!S.boardsOpen));
  $('#boardList').addEventListener('click', async e => {
    const li = e.target.closest('[data-board]'); if (!li) return;
    const id = li.dataset.board;
    const act = e.target.closest('[data-board-act]')?.dataset.boardAct;
    if (act === 'rename') {
      const name = prompt('Board name', S.boards.find(b => b.id === id)?.name ?? id);
      if (name?.trim()) await post(`/api/boards/${encodeURIComponent(id)}`, { name }, 'PATCH').catch(err => toast(err.message));
      return;
    }
    if (act === 'rm') {
      if (!confirm(`Archive board “${S.boards.find(b => b.id === id)?.name ?? id}”? Its notes and tours move to ~/.diffboard/archive.`)) return;
      await api(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(err => toast(err.message));
      return;
    }
    switchBoard(id);
  });
  $('#newBoard').addEventListener('click', async () => {
    const name = prompt('New board name (e.g. the task an agent works on)');
    if (!name?.trim()) return;
    const paths = prompt('Repositories to watch, comma-separated absolute paths (optional)') || '';
    try {
      const b = await post('/api/boards', { name, repos: paths.split(',').map(x => x.trim()).filter(Boolean).map(path => ({ path })) });
      await loadBoards();
      switchBoard(b.id);
    } catch (err) { toast(err.message); }
  });
  // relative times and the live pulse age without server events
  setInterval(() => { if (S.boards.length) renderBoards(); }, 5000);

  /* ---------------- context menu (right click on the graph and on diff cards) ---------------- */
  const noteLink = id => `${location.origin}/#${S.board !== 'default' ? `board=${encodeURIComponent(S.board)}&` : ''}note=${id}`;
  let menuItems = [];
  function showMenu(ev, items) {
    const m = $('#ctxMenu');
    menuItems = items.filter(Boolean);
    m.innerHTML = menuItems.map((it, i) => it === '-' ? '<div class="sep" role="separator"></div>'
      : it.label ? `<div class="mlabel">${esc(it.label)}</div>`
      : `<button class="mi${it.danger ? ' danger' : ''}" data-mi="${i}" role="menuitem"${it.disabled ? ' disabled' : ''}><span>${esc(it.text)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</button>`).join('');
    m.hidden = false;
    const x = Math.min(ev.clientX, innerWidth - m.offsetWidth - 6), y = Math.min(ev.clientY, innerHeight - m.offsetHeight - 6);
    m.style.left = `${Math.max(6, x)}px`; m.style.top = `${Math.max(6, y)}px`;
    m.querySelector('.mi:not([disabled])')?.focus();
  }
  const hideMenu = () => { $('#ctxMenu').hidden = true; };
  $('#ctxMenu').addEventListener('click', e => {
    const b = e.target.closest('[data-mi]'); if (!b) return;
    const it = menuItems[Number(b.dataset.mi)];
    hideMenu();
    Promise.resolve(it.run()).catch(err => toast(err.message));
  });
  $('#ctxMenu').addEventListener('keydown', e => {
    const items = [...$('#ctxMenu').querySelectorAll('.mi:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); hideMenu(); }
  });
  addEventListener('pointerdown', e => { if (!e.target.closest('#ctxMenu')) hideMenu(); }, true);
  addEventListener('blur', hideMenu);
  addEventListener('resize', hideMenu);
  // the browser's own menu never shows over the board; cards get the file menu
  $('.canvasWrap').addEventListener('contextmenu', e => {
    e.preventDefault();
    const card = e.target.closest('.card');
    if (card) graphMenu(S.cy.getElementById(card.dataset.id), e);
  });

  async function removeRepo(id) {
    const r = repoOf(id);
    if (!confirm(`Remove ${id} from the board “${S.boards.find(b => b.id === S.board)?.name ?? S.board}”?\n\nOnly the board stops watching it: nothing in the repository changes, notes stay, and \`diffboard add ${r?.path ?? id}\` brings it back.`)) return;
    await api(`${B()}/repos?repo=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (S.open?.kind === 'file' && S.open.repo === id) { if (S.fedit) await endEdit(false); S.open = null; S.sel = null; paintSel(); $('#fileView').hidden = true; $('#placeholder').hidden = false; setHash(); }
    toast(`${id} removed from the board`);
  }
  function pickBase(id) {
    const t = document.querySelector(`#repos [data-pick-base="${CSS.escape(id)}"]`);
    if (t) t.click(); else toast('The repo is not in the title bar');
  }
  async function setCards(ids, on) {
    for (const id of ids) on ? S.expanded.add(id) : S.expanded.delete(id);
    persistExpanded();
    if (await renderCards(S.data)) layout(false);
    syncCards();
  }

  function graphMenu(target, ev) {
    if (!ev) return;
    const cy = S.cy;
    if (target === cy || !target?.isNode?.()) {
      return showMenu(ev, [
        { text: 'Fit to view', run: () => cy.animate({ fit: { eles: cy.elements().not('.hidden'), padding: 60 }, duration: 300 }) },
        { text: 'Re-layout', run: () => layout(true) },
        '-',
        { text: 'Expand all diffs', run: () => $('#expandAll').click() },
        { text: 'Collapse all diffs', run: () => $('#collapseAll').click() },
        '-',
        { text: 'New note', run: () => createNote({ title: 'New note', links: [] }) },
      ]);
    }
    if (target.hasClass('repo')) {
      const id = target.id().slice('repo:'.length), r = repoOf(id);
      const files = S.data.nodes.filter(n => n.repo === id && expandable(n)).map(n => n.id);
      return showMenu(ev, [
        { label: `${id} · ${r?.branch ?? ''}` },
        { text: 'Change base…', run: () => pickBase(id) },
        { text: 'Copy repo path', run: () => copy(r?.path ?? id, 'Path copied') },
        { text: 'Fit to this repo', run: () => cy.animate({ fit: { eles: target.union(target.descendants()), padding: 60 }, duration: 300 }) },
        '-',
        { text: 'Expand diffs in this repo', disabled: !files.length, run: () => setCards(files, true) },
        { text: 'Collapse diffs in this repo', disabled: !files.length, run: () => setCards(files, false) },
        '-',
        { text: 'Remove repo from board…', danger: true, run: () => removeRepo(id) },
      ]);
    }
    if (target.hasClass('note')) {
      const id = target.data('noteId');
      return showMenu(ev, [
        { label: `✎ ${S.data.notes.find(n => n.id === id)?.title ?? 'note'}` },
        { text: 'Open', run: () => openNote(id) },
        { text: 'Edit', run: () => openNote(id, true) },
        { text: 'Copy link', run: () => copy(noteLink(id), 'Note link copied') },
        '-',
        { text: 'Delete note…', danger: true, run: async () => {
          if (!confirm('Delete this note?')) return;
          await api(`${B()}/notes/${id}`, { method: 'DELETE' });
          if (S.open?.kind === 'note' && S.open.id === id) { S.open = null; $('#noteView').hidden = true; $('#placeholder').hidden = false; setHash(); }
        } },
      ]);
    }
    if (target.hasClass('dir')) {
      const repo = target.data('repo'), path = target.data('path'), key = `${repo}:${path}`;
      const parent = path.includes('/') ? `${repo}:${path.split('/').slice(0, -1).join('/')}` : null;
      return showMenu(ev, [
        { label: `${path}/` },
        { text: 'Unfold', run: () => toggleDir(key, true) },
        parent && S.mapOpen.has(parent) && { text: `Fold ${parent.split(':')[1]}/`, run: () => toggleDir(parent, false) },
        { text: 'Show in Files', run: () => { setBoardsOpen(true); setDockTab('files'); for (let p = path.split('/'), i = 1; i <= p.length; i++) S.treeOpen.add(`${repo}:${p.slice(0, i).join('/')}`); renderTree(); } },
        { text: 'Copy path', run: () => copy(`${repoOf(repo)?.path}/${path}`, 'Path copied') },
      ].filter(Boolean));
    }
    const n = S.data.nodes.find(x => x.id === target.id()) ?? (target.hasClass('file') ? { id: target.id(), repo: target.data('repo'), path: target.data('path'), status: 'N' } : null);
    if (!n) return;
    const r = repoOf(n.repo), abs = `${r?.path}/${n.path}`, changed = n.status !== 'N';
    const reviewed = isReviewed(n.id);
    return showMenu(ev, [
      { label: n.path },
      { text: 'Open', run: () => openFile(n.repo, n.path) },
      { text: 'Open in Zed', run: () => post(`${B()}/open`, { editor: 'zed', repo: n.repo, path: n.path }) },
      { text: 'Open in VS Code', run: () => post(`${B()}/open`, { editor: 'vscode', repo: n.repo, path: n.path }) },
      '-',
      { text: 'Copy path', run: () => copy(abs, 'Path copied') },
      { text: 'Copy relative path', run: () => copy(n.path, 'Path copied') },
      '-',
      expandable(n) && { text: S.expanded.has(n.id) ? 'Collapse diff' : 'Expand diff', run: () => toggleCard(n.id) },
      changed && n.status !== 'D' && { text: reviewed ? 'Mark not reviewed' : 'Mark reviewed', key: 'x', run: () => setReviewed(n.id, !reviewed) },
      { text: 'New note on this file', run: () => createNote({ title: `Note on ${base(n.path)}`, links: [`${n.repo}:${n.path}`] }) },
      '-',
      S.graphMode === 'map' && n.path.includes('/') && { text: `Fold ${n.path.split('/').slice(0, -1).join('/')}/`, run: () => { const p = n.path.split('/'); for (let i = p.length - 1; i >= 1; i--) { const k = `${n.repo}:${p.slice(0, i).join('/')}`; if (S.mapOpen.has(k)) return toggleDir(k, false); } } },
      { text: `Remove ${n.repo} from board…`, danger: true, run: () => removeRepo(n.repo) },
    ].filter(Boolean));
  }

  /* ---------------- files: tree of every file in the board's repos, and quick open ---------------- */
  let filesAt = 0, filesLoading = null;
  async function loadFiles(force = false) {
    if (filesLoading) return filesLoading;
    if (S.files && S.files.board === S.board && !force && Date.now() - filesAt < 5000) return S.files;
    filesLoading = api(`${B()}/files`).then(r => { S.files = { board: S.board, repos: r.repos }; filesAt = Date.now(); return S.files; }).finally(() => { filesLoading = null; });
    return filesLoading;
  }
  const statusOf = (repo, path) => S.data?.nodes.find(n => n.repo === repo && n.path === path && n.status !== 'N')?.status;

  /** Nested directories of one repo, built from its sorted file list. */
  function treeOf(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.split('/');
      let d = root;
      for (let i = 0; i < parts.length - 1; i++) { if (!d.dirs.has(parts[i])) d.dirs.set(parts[i], { dirs: new Map(), files: [] }); d = d.dirs.get(parts[i]); }
      d.files.push(f);
    }
    return root;
  }
  let treeCache = { key: '', trees: new Map() };

  function renderTree() {
    if (S.dockTab !== 'files' || !S.boardsOpen) return;
    const el = $('#fileTree');
    if (!S.files || S.files.board !== S.board) { el.innerHTML = '<li class="meta tmsg">Loading…</li>'; loadFiles().then(renderTree, err => { el.innerHTML = `<li class="meta tmsg">${esc(err.message)}</li>`; }); return; }
    const cur = S.open?.kind === 'file' ? `${S.open.repo}:${S.open.path}` : '';
    const changedDirs = new Set();
    for (const n of S.data?.nodes ?? []) if (n.status !== 'N') { const p = n.path.split('/'); for (let i = 1; i < p.length; i++) changedDirs.add(`${n.repo}:${p.slice(0, i).join('/')}`); }
    const fileRow = (repo, f, depth, showDir) => {
      const st = statusOf(repo, f), name = f.split('/').pop(), id = `${repo}:${f}`;
      return `<li class="tf${id === cur ? ' cur' : ''}${st ? ' st-' + st : ''}" data-tfile="${esc(id)}" style="--d:${depth}" role="treeitem" title="${esc(f)}"><span class="tn">${esc(name)}</span>${showDir ? `<span class="td">${esc(f.split('/').slice(0, -1).join('/'))}</span>` : ''}${st ? `<span class="ts">${st === 'U' ? 'A' : st}</span>` : ''}</li>`;
    };
    const q = S.treeFilter.trim().toLowerCase();
    if (q) {
      // filtered: a flat list of matches, best (name) matches first
      const hits = [];
      for (const { repo, files } of S.files.repos) for (const f of files) { const i = f.toLowerCase().indexOf(q); if (i >= 0) hits.push({ repo, f, score: (f.toLowerCase().lastIndexOf('/') < i ? 0 : 1) * 1000 + f.length }); }
      hits.sort((a, b) => a.score - b.score);
      el.innerHTML = hits.slice(0, 300).map(h => fileRow(h.repo, h.f, 0, true)).join('') + (hits.length > 300 ? `<li class="meta tmsg">${hits.length - 300} more…</li>` : '') || '<li class="meta tmsg">No matching files.</li>';
      return;
    }
    const key = S.files.board + filesAt;
    if (treeCache.key !== key) treeCache = { key, trees: new Map(S.files.repos.map(r => [r.repo, treeOf(r.files)])) };
    const out = [];
    const walk = (repo, d, prefix, depth) => {
      for (const [name, sub] of [...d.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        // single-child folder chains collapse into one row, like Zed's project panel
        let label = name, path = prefix + name, node = sub;
        while (node.files.length === 0 && node.dirs.size === 1) { const [n2, s2] = [...node.dirs][0]; label += '/' + n2; path += '/' + n2; node = s2; }
        const id = `${repo}:${path}`, open = S.treeOpen.has(id);
        out.push(`<li class="tdir${open ? ' open' : ''}${changedDirs.has(id) ? ' changed' : ''}" data-tdir="${esc(id)}" style="--d:${depth}" role="treeitem" aria-expanded="${open}"><span class="chev"></span><span class="tn">${esc(label)}</span></li>`);
        if (open) walk(repo, node, path + '/', depth + 1);
      }
      for (const f of d.files) out.push(fileRow(repo, f, depth, false));
    };
    const many = S.files.repos.length > 1;
    for (const { repo } of S.files.repos) {
      const id = `${repo}:`, open = !many || S.treeOpen.has(id);
      if (many) out.push(`<li class="tdir troot${open ? ' open' : ''}" data-tdir="${esc(id)}" style="--d:0" aria-expanded="${open}"><span class="chev"></span><span class="tn">${esc(repo)}</span></li>`);
      if (open) walk(repo, treeCache.trees.get(repo), '', many ? 1 : 0);
    }
    el.innerHTML = out.join('') || '<li class="meta tmsg">No repositories on this board.</li>';
  }

  /* the open file: its folders unfold and the row scrolls into view */
  function revealInTree() {
    if (S.open?.kind !== 'file' || S.dockTab !== 'files' || S.treeFilter) return renderTree();
    const parts = S.open.path.split('/');
    if (S.files?.repos.length > 1) S.treeOpen.add(`${S.open.repo}:`);
    for (let i = 1; i < parts.length; i++) S.treeOpen.add(`${S.open.repo}:${parts.slice(0, i).join('/')}`);
    renderTree();
    // collapsed chains are keyed by their full path; open every prefix so the chain row is open too
    $('#fileTree .tf.cur')?.scrollIntoView({ block: 'nearest' });
  }

  function setDockTab(tab) {
    S.dockTab = tab;
    try { localStorage.setItem('diffboard.dockTab', tab); } catch {}
    document.querySelectorAll('.docktabs [data-dock]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.dock === tab)));
    document.querySelectorAll('.dockpane').forEach(p => { p.hidden = p.dataset.pane !== tab; });
    $('#newBoard').hidden = tab !== 'boards'; $('#collapseTree').hidden = tab !== 'files';
    if (tab === 'files') loadFiles(true).then(revealInTree).catch(() => renderTree());
  }
  document.querySelector('.docktabs').addEventListener('click', e => { const b = e.target.closest('[data-dock]'); if (b) setDockTab(b.dataset.dock); });
  $('#collapseTree').addEventListener('click', () => { S.treeOpen.clear(); renderTree(); });
  $('#treeFilter').addEventListener('input', e => { S.treeFilter = e.target.value; renderTree(); });
  $('#treeFilter').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; S.treeFilter = ''; renderTree(); } if (e.key === 'Enter') $('#fileTree .tf')?.click(); });
  $('#fileTree').addEventListener('click', e => {
    const d = e.target.closest('[data-tdir]');
    if (d) { const id = d.dataset.tdir; S.treeOpen.has(id) ? S.treeOpen.delete(id) : S.treeOpen.add(id); return renderTree(); }
    const f = e.target.closest('[data-tfile]');
    if (f) { const id = f.dataset.tfile, i = id.indexOf(':'); openFile(id.slice(0, i), id.slice(i + 1)); }
  });
  $('#fileTree').addEventListener('contextmenu', e => {
    const f = e.target.closest('[data-tfile]'); if (!f) return;
    e.preventDefault();
    const id = f.dataset.tfile, i = id.indexOf(':'), repo = id.slice(0, i), path = id.slice(i + 1), abs = `${repoOf(repo)?.path}/${path}`;
    showMenu(e, [{ label: path }, { text: 'Open', run: () => openFile(repo, path) }, { text: 'Open in Zed', run: () => post(`${B()}/open`, { editor: 'zed', repo, path }) }, { text: 'Open in VS Code', run: () => post(`${B()}/open`, { editor: 'vscode', repo, path }) }, '-', { text: 'Copy path', run: () => copy(abs, 'Path copied') }, { text: 'Copy relative path', run: () => copy(path, 'Path copied') }, { text: 'New note on this file', run: () => createNote({ title: `Note on ${base(path)}`, links: [id] }) }]);
  });

  /* quick open: fuzzy search over every file of the board */
  function fuzzy(q, s) {
    // subsequence match; consecutive letters and letters in the file name score higher
    let qi = 0, score = 0, run = 0;
    const nameAt = s.lastIndexOf('/') + 1;
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) { qi++; run++; score += 1 + run * 2 + (i >= nameAt ? 3 : 0) + (i === nameAt || s[i - 1] === '/' || s[i - 1] === '-' || s[i - 1] === '_' || s[i - 1] === '.' ? 4 : 0); }
      else run = 0;
    }
    return qi === q.length ? score - s.length * 0.02 : -1;
  }
  let qoItems = [], qoIdx = 0;
  async function openQuick() {
    $('#quickOpen').hidden = false;
    $('#qoInput').value = '';
    $('#qoInput').focus();
    $('#qoList').innerHTML = '<li class="meta">Loading…</li>';
    await loadFiles().catch(err => { $('#qoList').innerHTML = `<li class="meta">${esc(err.message)}</li>`; });
    renderQuick();
  }
  const closeQuick = () => { $('#quickOpen').hidden = true; };
  function renderQuick() {
    if (!S.files) return;
    const q = $('#qoInput').value.trim().toLowerCase().replace(/\s+/g, '');
    const all = S.files.repos.flatMap(r => r.files.map(f => ({ repo: r.repo, f })));
    if (!q) {
      // nothing typed: changed files first, then recently opened ones
      const changed = (S.data?.nodes ?? []).filter(n => n.status !== 'N' && n.status !== 'D').map(n => ({ repo: n.repo, f: n.path }));
      qoItems = changed.slice(0, 50);
    } else {
      qoItems = all.map(x => ({ ...x, s: fuzzy(q, x.f.toLowerCase()) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 50);
    }
    qoIdx = 0;
    const many = S.files.repos.length > 1;
    $('#qoList').innerHTML = qoItems.map((x, i) => {
      const st = statusOf(x.repo, x.f);
      return `<li data-qo="${i}" class="${i === 0 ? 'cur' : ''}${st ? ' st-' + st : ''}" role="option"><span class="tn">${esc(x.f.split('/').pop())}</span><span class="td">${many ? esc(x.repo) + ':' : ''}${esc(x.f.split('/').slice(0, -1).join('/'))}</span>${st ? `<span class="ts">${st === 'U' ? 'A' : st}</span>` : ''}</li>`;
    }).join('') || `<li class="meta">${q ? 'No matching files.' : 'No changed files. Type to search all files.'}</li>`;
  }
  function pickQuick(i) {
    const x = qoItems[i]; if (!x) return;
    closeQuick();
    openFile(x.repo, x.f);
  }
  $('#qoInput').addEventListener('input', renderQuick);
  $('#qoInput').addEventListener('keydown', e => {
    const move = d => { qoIdx = Math.max(0, Math.min(qoItems.length - 1, qoIdx + d)); $('#qoList').querySelectorAll('li').forEach((li, i) => li.classList.toggle('cur', i === qoIdx)); $('#qoList li.cur')?.scrollIntoView({ block: 'nearest' }); };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    if (e.key === 'Enter') { e.preventDefault(); pickQuick(qoIdx); }
    if (e.key === 'Escape') { e.preventDefault(); closeQuick(); }
  });
  $('#qoList').addEventListener('click', e => { const li = e.target.closest('[data-qo]'); if (li) pickQuick(Number(li.dataset.qo)); });
  $('#quickOpen').addEventListener('pointerdown', e => { if (e.target.id === 'quickOpen') closeQuick(); });
  addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openQuick(); }
  }, true);

  /* ---------------- activity ---------------- */
  function renderActivity(data) {
    $('#actList').innerHTML = data.activity.map((a, i) => `<li data-i="${i}" title="${esc(a.text)}"><time>${time(a.at)}</time><span class="txt k-${a.kind}">${a.repo ? `<b>${esc(a.repo)}</b> ` : ''}${esc(a.text)}</span></li>`).join('') || '<li class="meta">Changes appear here as they happen.</li>';
  }
  $('#actList').addEventListener('click', e => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    const a = S.data.activity[Number(li.dataset.i)];
    if (a.note) openNote(a.note); else if (a.path) openFile(a.repo, a.path);
  });
  $('#actToggle').addEventListener('click', () => { const box = $('#activity'); const c = box.dataset.collapsed === '1'; box.dataset.collapsed = c ? '0' : '1'; $('#actToggle').setAttribute('aria-expanded', String(c)); });

  /* ---------------- diff parsing & rendering ---------------- */
  function parseDiff(text) {
    const hunks = []; let h = null; let o = 0, n = 0;
    for (const line of (text || '').split('\n')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (m) { h = { header: line, rows: [] }; hunks.push(h); o = Number(m[1]); n = Number(m[2]); continue; }
      if (!h || line.startsWith('\\')) continue;
      const t = line[0], body = line.slice(1);
      if (t === '+') h.rows.push({ type: 'add', new: n++, text: body });
      else if (t === '-') h.rows.push({ type: 'del', old: o++, text: body });
      else if (t === ' ') h.rows.push({ type: 'ctx', old: o++, new: n++, text: body });
    }
    return hunks;
  }
  const LANG = { ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', css: 'css', scss: 'scss', md: 'markdown', sql: 'sql', yml: 'yaml', yaml: 'yaml', sh: 'bash', go: 'go', py: 'python', html: 'xml', vue: 'xml', prisma: 'typescript' };
  const langOf = p => LANG[p.split('.').pop()] || null;
  function hl(text, lang) {
    if (!lang || !window.hljs) return esc(text);
    try { return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { return esc(text); }
  }

  function renderUnified(hunks, lang) {
    let html = '<table class="unified"><tbody>';
    for (const h of hunks) {
      html += `<tr class="hunk"><td colspan="4">${esc(h.header)}</td></tr>`;
      for (const r of h.rows) {
        html += `<tr class="${r.type === 'ctx' ? '' : r.type}" ${r.new ? `data-new="${r.new}"` : ''} ${r.old ? `data-old="${r.old}"` : ''}>
          <td class="ln" data-side="old" data-n="${r.old ?? ''}">${r.old ?? ''}</td><td class="ln" data-side="new" data-n="${r.new ?? ''}">${r.new ?? ''}</td>
          <td class="mk">${r.type === 'add' ? '+' : r.type === 'del' ? '−' : ''}</td><td class="c" data-side="${r.new ? 'new' : 'old'}" data-n="${r.new ?? r.old}">${hl(r.text, lang)}</td></tr>`;
      }
    }
    return html + '</tbody></table>';
  }

  function renderSplit(hunks, lang) {
    let html = '<table class="split"><tbody>';
    for (const h of hunks) {
      html += `<tr class="hunk"><td colspan="4">${esc(h.header)}</td></tr>`;
      const rows = h.rows;
      for (let i = 0; i < rows.length; ) {
        if (rows[i].type === 'ctx') {
          const r = rows[i++];
          html += `<tr data-new="${r.new}" data-old="${r.old}"><td class="ln" data-side="old" data-n="${r.old}">${r.old}</td><td class="c" data-side="old" data-n="${r.old}">${hl(r.text, lang)}</td><td class="ln" data-side="new" data-n="${r.new}">${r.new}</td><td class="c" data-side="new" data-n="${r.new}">${hl(r.text, lang)}</td></tr>`;
          continue;
        }
        const dels = [], adds = [];
        while (i < rows.length && rows[i].type === 'del') dels.push(rows[i++]);
        while (i < rows.length && rows[i].type === 'add') adds.push(rows[i++]);
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
          const d = dels[k], a = adds[k];
          html += `<tr ${a ? `data-new="${a.new}"` : ''} ${d ? `data-old="${d.old}"` : ''}>${d ? `<td class="ln" data-side="old" data-n="${d.old}">${d.old}</td><td class="c del" data-side="old" data-n="${d.old}">${hl(d.text, lang)}</td>` : '<td class="ln"></td><td class="c blank"></td>'}${a ? `<td class="ln" data-side="new" data-n="${a.new}">${a.new}</td><td class="c add" data-side="new" data-n="${a.new}">${hl(a.text, lang)}</td>` : '<td class="ln"></td><td class="c blank"></td>'}</tr>`;
        }
      }
    }
    return html + '</tbody></table>';
  }

  function renderWhole(content, lang, side, hunks) {
    if (content == null) return `<div class="binary">${side === 'old' ? 'The file did not exist at the base.' : 'The file is deleted in the working tree.'}</div>`;
    const marked = new Set();
    for (const h of hunks || []) for (const r of h.rows) { if (side === 'new' && r.type === 'add') marked.add(r.new); if (side === 'old' && r.type === 'del') marked.add(r.old); }
    const lines = content.split('\n'); if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let html = '<table class="whole"><tbody>';
    lines.forEach((t, i) => { const n = i + 1; html += `<tr data-${side}="${n}" class="${marked.has(n) ? (side === 'new' ? 'add changedLine' : 'del') : ''}"><td class="ln" data-side="${side}" data-n="${n}">${n}</td><td class="c" data-side="${side}" data-n="${n}">${hl(t, lang)}</td></tr>`; });
    return html + '</tbody></table>';
  }

  /* ---------------- file panel ---------------- */
  const nodeOf = (repo, path) => S.data?.nodes.find(n => n.repo === repo && n.path === path);
  const repoOf = id => S.data?.repos.find(r => r.id === id);
  const sigOf = n => n ? `${n.status}|${n.add}|${n.del}|${n.changedAt ?? ''}` : '';

  async function openFile(repo, path, opts = {}) {
    if (S.fedit) await endEdit(false);
    if (S.pane === 'graph') setPane('both');
    S.focusOff = false;
    const n = nodeOf(repo, path);
    const newNode = !(S.open?.kind === 'file' && S.open.repo === repo && S.open.path === path);
    if (newNode && !opts.fromNav) rememberScroll();
    S.open = { kind: 'file', repo, path };
    S.lastFile = { repo, path };
    S.lspOcc = null; S.lspSym = null; paintOcc(); hideTip(true);
    if (newNode) requestAnimationFrame(revealInTree);
    if (newNode && S.graphMode === 'map') revealOnMap(repo, path);
    S.editing = false;
    if (opts.view) S.view = opts.view;
    else if (isMd(path) && n?.status !== 'D') S.view = 'preview'; // markdown opens rendered; Diff is one click away
    else if ((!n || n.status === 'N') && S.view === 'diff') S.view = 'new'; // unchanged, or not on the graph at all
    if (S.view === 'preview' && (!isMd(path) || n?.status === 'D')) S.view = n && n.status !== 'N' ? 'diff' : 'new';
    if (S.view === 'diff' && (!n || n.status === 'N')) S.view = isMd(path) ? 'preview' : 'new'; // nothing to diff
    S.sel = opts.lines ? { side: opts.side || 'new', start: opts.lines[0], end: opts.lines[1] } : null;
    setHash(newNode && !opts.fromNav);
    await loadFile(true);
    applyFocus(true);
    if (opts.lines) scrollToSel(true);
    else if (opts.scroll != null) { const c = $('#fileView .code'); if (c) c.scrollTop = opts.scroll; }
    renderReview();
  }

  async function loadFile(reset) {
    const { repo, path } = S.open;
    const n = nodeOf(repo, path);
    const q = `repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`;
    const changed = n && n.status !== 'N';
    S.diff = changed ? (await api(`${B()}/diff?${q}${S.fullDiff ? '&full=1' : ''}`).catch(() => ({ diff: '' }))).diff : '';
    // File and Preview read the working-tree side, Base the merge-base
    S.content = S.view === 'diff' ? null : (await api(`${B()}/file?${q}&side=${S.view === 'old' ? 'old' : 'new'}`).catch(() => ({ content: null }))).content;
    S.openSig = sigOf(n);
    renderFile(reset);
  }

  function renderFile(reset) {
    const { repo, path } = S.open;
    const n = nodeOf(repo, path) || { status: 'N', add: 0, del: 0 };
    const r = repoOf(repo);
    const notes = (S.data?.notes || []).filter(x => x.links.some(l => l.repo === repo && l.path === path));
    const changed = n.status !== 'N';
    const scroller = $('#fileView .code');
    const keep = scroller && !reset ? scroller.scrollTop : 0;
    const liveEditor = S.fedit ? $('#fileView .editor') : null;
    // a rendered preview survives re-renders while the file is unchanged (diagram zoom, scroll)
    const livePreview = S.view === 'preview' && !reset ? $('#mdPreview') : null;
    const keepPreview = livePreview && livePreview._src === S.content ? livePreview : null;
    const tabs = [['diff', 'Diff', changed], ['preview', 'Preview', isMd(path) && n.status !== 'D'], ['new', 'File', n.status !== 'D'], ['old', 'Base', changed && n.status !== 'A' && n.status !== 'U']]
      .filter(t => t[2]).map(([id, l]) => `<button data-view="${id}" aria-pressed="${S.view === id}">${l}</button>`).join('');
    const hunks = parseDiff(S.diff);
    const lang = langOf(path);
    let body;
    const editable = n.status !== 'D' && !n.binary;
    if (S.fedit) body = '<textarea class="editor" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Edit file"></textarea>';
    else if (n.binary) body = '<div class="binary">Binary file.</div>';
    else if (S.view === 'preview') body = '<div class="notebody mdpreview" id="mdPreview"></div>';
    else if (S.view === 'diff') body = hunks.length ? (S.layout === 'split' ? renderSplit(hunks, lang) : renderUnified(hunks, lang)) : '<div class="binary">No textual changes.</div>';
    else body = renderWhole(S.content, lang, S.view === 'old' ? 'old' : 'new', hunks);
    $('#fileView').innerHTML = `<div class="phead">
        <div class="prow"><span class="badge ${n.status}">${{ A: 'added', U: 'new', M: 'modified', D: 'deleted', R: 'renamed', N: 'unchanged' }[n.status]}</span><span class="path">${esc(repo)}:${esc(path)}</span>${n.oldPath ? `<span class="meta">from ${esc(n.oldPath)}</span>` : ''}</div>
        <div class="prow">${S.fedit ? '<b>Editing working tree</b>' : `<div class="seg" id="viewSeg">${tabs}</div>`}
          ${S.view === 'diff' && !S.fedit ? `<div class="seg" id="ctxSeg" title="Whole file with the changes marked, or only the changed hunks"><button data-full="1" aria-pressed="${S.fullDiff}">Full</button><button data-full="0" aria-pressed="${!S.fullDiff}">Hunks</button></div>` : ''}
          ${S.view === 'diff' && !S.fedit ? `<div class="seg" id="layoutSeg"><button data-layout="unified" aria-pressed="${S.layout === 'unified'}">Unified</button><button data-layout="split" aria-pressed="${S.layout === 'split'}">Split</button></div>` : ''}
          ${changed ? `<span class="stat"><span class="p">+${n.add}</span> <span class="m">−${n.del}</span></span>` : ''}
          <span class="spacer"></span>
          ${S.fedit ? `<span class="savestate ${S.fedit.status}" id="saveState">${saveLabel()}</span>${S.fedit.status === 'conflict' ? '<button class="btn" data-act="editReload" title="Drop your edits and load the version on disk">Reload</button><button class="btn danger" data-act="editOverwrite" title="Write your version over the one on disk">Overwrite</button>' : ''}` : ''}
          ${editable ? `<button class="btn${S.fedit ? ' primary' : ''}" data-act="edit" title="${S.fedit ? 'Save and go back to the preview (Esc)' : 'Edit the file in place, saved as you type (e)'}">${S.fedit ? 'Done' : 'Edit'}</button>` : ''}
          <button class="btn" data-act="copyPath" title="Absolute path, for pasting into a chat">Copy path</button>
          <button class="btn" data-editor="vscode" title="Open in VS Code">VS Code</button>
          <button class="btn" data-editor="zed" title="Open in Zed">Zed</button>
          <button class="btn" data-act="noteFile">Note</button>
          ${changed ? `<button class="btn${isReviewed(`${repo}:${path}`) ? ' on' : ''}" data-act="reviewed" title="Toggle reviewed (x marks it and moves on)">${isReviewed(`${repo}:${path}`) ? '✓ Reviewed' : 'Mark reviewed'}</button>` : ''}
          <button class="btn" data-act="nextReview" title="Next file in the review order (j)">Next ›</button></div>
        ${notes.length ? `<div class="linked">${notes.map(x => `<span class="notechip" data-note="${x.id}">✎ ${esc(x.title)}</span>`).join('')}</div>` : ''}
      </div><div class="code${S.fedit ? ' editing' : ''}">${body}</div>`;
    // the live editor survives re-renders (board refreshes after every save), with its cursor and scroll
    if (S.fedit) { const fresh = $('#fileView .editor'); if (liveEditor) fresh.replaceWith(liveEditor); else fresh.value = S.fedit.text; }
    $('#placeholder').hidden = true; $('#noteView').hidden = true; $('#fileView').hidden = false;
    if (S.fedit) return;
    if (S.view === 'preview') {
      const el = $('#mdPreview');
      if (keepPreview) el.replaceWith(keepPreview);
      else {
        el._src = S.content;
        renderMarkdown(el, S.content ?? '', `${repo}:${path}`, { repo, path }).then(() => { const c = $('#fileView .code'); if (c) c.scrollTop = keep; });
      }
    }
    $('#fileView .code').scrollTop = keep;
    if (reset && !S.sel) scrollToFirstChange();
    paintSel();
    paintOcc();
  }

  $('#fileView').addEventListener('click', async e => {
    const v = e.target.closest('[data-view]'); if (v) { S.view = v.dataset.view; S.sel = null; setHash(); return loadFile(true); }
    const l = e.target.closest('[data-layout]'); if (l) { S.layout = l.dataset.layout; return renderFile(false); }
    const fu = e.target.closest('[data-full]'); if (fu) { S.fullDiff = fu.dataset.full === '1'; try { localStorage.setItem('diffboard.fullDiff', fu.dataset.full); } catch {} return loadFile(true); }
    const chip = e.target.closest('[data-note]'); if (chip) return openNote(chip.dataset.note);
    const md = e.target.closest('[data-md-link]'); if (md) return openFile(S.open.repo, md.dataset.mdLink);
    const act = e.target.closest('[data-act]')?.dataset.act;
    const ed = e.target.closest('[data-editor]')?.dataset.editor;
    if (ed) return post(`${B()}/open`, { editor: ed, repo: S.open.repo, path: S.open.path, line: S.sel?.side === 'new' ? S.sel.start : undefined }).catch(err => toast(err.message));
    if (act === 'edit') return S.fedit ? endEdit(true) : startEdit();
    if (act === 'editReload') { S.fedit.dirty = false; return reloadEditor(true); }
    if (act === 'editOverwrite') { S.fedit.mtime = null; S.fedit.status = 'unsaved'; return saveEdit(); }
    if (act === 'copyPath') return copy(absPath(), 'Path copied');
    if (act === 'reviewed') return setReviewed(`${S.open.repo}:${S.open.path}`, !isReviewed(`${S.open.repo}:${S.open.path}`));
    if (act === 'nextReview') return stepReview(1);
    if (act === 'noteFile') return createNote({ title: `Note on ${base(S.open.path)}`, links: [`${S.open.repo}:${S.open.path}`] });
    const cell = e.target.closest('td[data-side][data-n]');
    if (cell?.classList.contains('c') && lspClick(e)) return;
    if (cell && cell.dataset.n) selectLine(cell, e.shiftKey);
  });

  /* ---------------- editing in the panel (autosave to the working tree) ---------------- */
  const wtQuery = () => `repo=${encodeURIComponent(S.open.repo)}&path=${encodeURIComponent(S.open.path)}`;
  const saveLabel = () => ({ saved: 'Saved', unsaved: 'Unsaved…', saving: 'Saving…', conflict: 'Changed on disk', error: 'Save failed' }[S.fedit.status]);
  function setSaveState(status) {
    S.fedit.status = status;
    const el = $('#saveState');
    // conflict buttons live in the header, so that state needs a full header render
    if (!el || status === 'conflict' || el.classList.contains('conflict')) return renderFile(false);
    el.className = `savestate ${status}`; el.textContent = saveLabel();
  }

  async function startEdit() {
    const r = await api(`${B()}/worktree?${wtQuery()}`).catch(err => { toast(err.message); return null; });
    if (!r) return;
    S.fedit = { text: r.content, mtime: r.mtime, dirty: false, timer: 0, saving: null, status: 'saved' };
    renderFile(false);
    const ta = $('#fileView .editor');
    ta.focus();
    // start where the reader was: the selected line, otherwise the top
    const line = S.sel?.side === 'new' ? S.sel.start : 1;
    const at = r.content.split('\n').slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
    ta.setSelectionRange(at, at);
    ta.scrollTop = Math.max(0, (line - 4) * parseFloat(getComputedStyle(ta).lineHeight));
  }

  async function saveEdit() {
    const f = S.fedit;
    if (!f) return;
    clearTimeout(f.timer);
    if (f.saving) { await f.saving; if (S.fedit !== f || !f.dirty) return; }
    if (!f.dirty && f.mtime !== null) return;
    const ta = $('#fileView .editor');
    const text = ta ? ta.value : f.text;
    setSaveState('saving');
    f.saving = (async () => {
      const res = await fetch(`${B()}/worktree?${wtQuery()}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text, mtime: f.mtime ?? undefined }) }).catch(() => null);
      const b = await res?.json().catch(() => ({}));
      if (S.fedit !== f) return;
      if (res?.status === 409) return setSaveState('conflict');
      if (!res?.ok) { toast(b?.error || 'Save failed'); return setSaveState('error'); }
      f.mtime = b.mtime; f.text = text;
      f.dirty = ($('#fileView .editor')?.value ?? text) !== text;
      setSaveState(f.dirty ? 'unsaved' : 'saved');
      if (f.dirty) f.timer = setTimeout(saveEdit, 700);
    })();
    await f.saving;
    f.saving = null;
  }

  /* take the version on disk (an agent edited the file) without losing the cursor */
  async function reloadEditor(force) {
    const f = S.fedit;
    if (!f || f.saving || (f.dirty && !force)) return;
    const r = await api(`${B()}/worktree?${wtQuery()}`).catch(() => null);
    if (!r || S.fedit !== f || (f.dirty && !force) || (r.mtime === f.mtime && !force)) return;
    f.text = r.content; f.mtime = r.mtime; f.dirty = false;
    const ta = $('#fileView .editor');
    if (ta && ta.value !== r.content) {
      const { selectionStart: a, selectionEnd: b, scrollTop } = ta;
      ta.value = r.content; ta.setSelectionRange(a, b); ta.scrollTop = scrollTop;
    }
    setSaveState('saved');
  }

  async function endEdit(reload) {
    const f = S.fedit;
    if (!f) return;
    if (f.dirty && f.status !== 'conflict') await saveEdit();
    if (f.dirty && !confirm('Your edits could not be saved. Discard them?')) return;
    S.fedit = null;
    if (reload) await loadFile(false);
  }

  $('#fileView').addEventListener('input', e => {
    if (!S.fedit || !e.target.matches('.editor')) return;
    S.fedit.dirty = true;
    if (S.fedit.status === 'conflict') return;
    clearTimeout(S.fedit.timer);
    S.fedit.timer = setTimeout(saveEdit, 700);
    if (S.fedit.status !== 'unsaved' && !S.fedit.saving) setSaveState('unsaved');
  });
  $('#fileView').addEventListener('keydown', e => {
    if (!S.fedit || !e.target.matches('.editor')) return;
    const ta = e.target;
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveEdit(); return; }
    if (e.key === 'Escape') { e.preventDefault(); endEdit(true); return; }
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // indent with whatever the file already uses
      e.preventDefault();
      const unit = /^\t/m.test(ta.value) ? '\t' : '  ';
      document.execCommand('insertText', false, unit);
    }
  });
  window.addEventListener('beforeunload', e => {
    const f = S.fedit;
    if (!f?.dirty) return;
    if (f.status !== 'conflict') fetch(`${B()}/worktree?${wtQuery()}`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: $('#fileView .editor').value, mtime: f.mtime ?? undefined }) });
    else e.preventDefault();
  });

  /* ---------------- language server: types on hover, occurrences, definitions, references ---------------- */
  const LSP_RE = /\.(m|c)?[jt]sx?$|\.rs$/i;
  const lspOn = () => S.open?.kind === 'file' && LSP_RE.test(S.open.path) && !S.fedit && S.view !== 'preview' && S.view !== 'old';
  const hlReg = window.CSS?.highlights;
  const isWord = c => !!c && /[\p{L}\p{N}_$]/u.test(c);
  let lspPending = 0;

  function setLspStatus(text, title = '') { const el = $('#sbLsp'); el.textContent = text; el.title = title; }

  async function lspReq(op, pos) {
    lspPending++;
    if (lspPending === 1) setLspStatus('LSP …', 'Waiting for the language server (the first request loads the project)');
    try {
      const r = await post(`${B()}/lsp`, { op, repo: S.open.repo, path: S.open.path, line: pos.line, character: pos.start });
      setLspStatus(r.server ? `${r.server}` : '', 'Language server ready');
      return r;
    } catch (err) {
      setLspStatus('LSP ✕', err.message);
      if (op !== 'hover' && op !== 'highlight') toast(err.message);
      return {};
    } finally { lspPending--; }
  }

  /* text offsets inside a code cell <-> DOM ranges (the cell holds highlight.js spans) */
  function rangeIn(td, from, to) {
    const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let off = 0, started = false;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const len = n.length;
      if (!started && from <= off + len) { r.setStart(n, from - off); started = true; }
      if (started && to <= off + len) { r.setEnd(n, to - off); return r; }
      off += len;
    }
    return started ? r : null;
  }

  /** The identifier under the mouse in a working-tree code cell, with its line and character span. */
  function posAt(e) {
    const td = e.target.closest?.('#fileView .code td.c[data-side="new"]');
    if (!td || !lspOn()) return null;
    const cr = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!cr || !td.contains(cr.startContainer)) return null;
    let off = 0;
    const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (n === cr.startContainer) { off += cr.startOffset; break; } off += n.length; }
    const text = td.textContent;
    let s = off;
    if (!isWord(text[s]) && isWord(text[s - 1])) s--;
    if (!isWord(text[s])) return null;
    let en = s;
    while (s > 0 && isWord(text[s - 1])) s--;
    while (en < text.length && isWord(text[en])) en++;
    const range = rangeIn(td, s, en);
    const box = range?.getBoundingClientRect();
    if (!box || e.clientX < box.left - 1 || e.clientX > box.right + 1 || e.clientY < box.top - 1 || e.clientY > box.bottom + 1) return null;
    return { line: Number(td.dataset.n) - 1, start: s, end: en, word: text.slice(s, en), range, key: `${td.dataset.n}:${s}` };
  }

  /* occurrences of the clicked symbol in the open file */
  function paintOcc() {
    if (!hlReg) return;
    hlReg.delete('lsp-read'); hlReg.delete('lsp-write');
    const o = S.lspOcc;
    if (!o || o.repo !== S.open?.repo || o.path !== S.open?.path) return;
    const read = [], write = [];
    for (const r of o.ranges) {
      if (r.start.line !== r.end.line) continue;
      const td = document.querySelector(`#fileView .code td.c[data-side="new"][data-n="${r.start.line + 1}"]`);
      const range = td && rangeIn(td, r.start.character, r.end.character);
      if (range) (r.kind === 3 ? write : read).push(range);
    }
    if (read.length) hlReg.set('lsp-read', new Highlight(...read));
    if (write.length) hlReg.set('lsp-write', new Highlight(...write));
  }

  function lspClick(e) {
    if (!getSelection().isCollapsed) return false;
    const pos = posAt(e);
    if (!pos) { if (S.lspOcc) { S.lspOcc = null; paintOcc(); } return false; }
    S.lspSym = pos;
    if (e.metaKey || e.ctrlKey) { goDefinition(pos); return true; }
    const at = { ...S.open };
    lspReq('highlight', pos).then(r => {
      if (S.open?.path !== at.path || S.open?.repo !== at.repo) return;
      S.lspOcc = { repo: at.repo, path: at.path, ranges: r.ranges ?? [] };
      paintOcc();
      const n = S.lspOcc.ranges.length;
      if (n) setLspStatus(`${r.server} · ${n} occurrence${n === 1 ? '' : 's'} of ${pos.word}`, 'Shift+F12: references in the whole project');
    });
    return true;
  }

  /* hover: the symbol's type and docs */
  let tipTimer = 0, tipHide = 0, hoverKey = '';
  function hideTip(now) {
    clearTimeout(tipTimer); clearTimeout(tipHide);
    const go = () => { $('#lspTip').hidden = true; hoverKey = ''; hlReg?.delete('lsp-hover'); hlReg?.delete('lsp-link'); };
    if (now) go(); else tipHide = setTimeout(go, 250);
  }
  $('#fileView').addEventListener('mousemove', e => {
    if (!lspOn() || e.buttons) return;
    const pos = posAt(e);
    if (!pos) { if (hoverKey) hideTip(); return; }
    clearTimeout(tipHide);
    const link = e.metaKey || e.ctrlKey;
    hlReg?.delete(link ? 'lsp-hover' : 'lsp-link');
    hlReg?.set(link ? 'lsp-link' : 'lsp-hover', new Highlight(pos.range));
    if (pos.key === hoverKey) return;
    hoverKey = pos.key;
    $('#lspTip').hidden = true;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(async () => {
      const r = await lspReq('hover', pos);
      if (hoverKey !== pos.key || !r.hover?.trim()) return;
      showTip(r.hover, pos);
    }, 350);
  });
  $('#fileView').addEventListener('mouseleave', () => hideTip());

  function showTip(md, pos) {
    const tip = $('#lspTip');
    const html = window.marked ? marked.parse(md.replace(/^\(loading\.\.\.\) /m, '')) : `<pre>${esc(md)}</pre>`;
    tip.innerHTML = `<div class="tipbody">${window.DOMPurify ? DOMPurify.sanitize(html) : esc(md)}</div>
      <div class="tipfoot"><button class="btn" data-lsp="def">Definition <kbd>⌘</kbd>-click</button><button class="btn" data-lsp="refs">References <kbd>⇧F12</kbd></button></div>`;
    tip.querySelectorAll('pre code').forEach(c => { const lang = /language-(\w+)/.exec(c.className)?.[1]; c.innerHTML = hl(c.textContent, lang && window.hljs?.getLanguage(lang) ? lang : langOf(S.open.path)); });
    tip.hidden = false;
    S.lspTipPos = pos;
    const box = pos.range.getBoundingClientRect();
    const w = Math.min(560, innerWidth - 16);
    tip.style.maxWidth = `${w}px`;
    const left = Math.max(8, Math.min(box.left, innerWidth - tip.offsetWidth - 8));
    const above = box.top - tip.offsetHeight - 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${above > 8 ? above : box.bottom + 6}px`;
  }
  $('#lspTip').addEventListener('mouseenter', () => clearTimeout(tipHide));
  $('#lspTip').addEventListener('mouseleave', () => hideTip());
  $('#lspTip').addEventListener('click', e => {
    const a = e.target.closest('[data-lsp]')?.dataset.lsp;
    const pos = S.lspTipPos;
    if (!a || !pos) return;
    hideTip(true);
    if (a === 'def') goDefinition(pos); else findReferences(pos);
  });
  // holding ⌘/Ctrl turns the hovered symbol into a link
  addEventListener('keydown', e => { if ((e.key === 'Meta' || e.key === 'Control') && hlReg?.has('lsp-hover')) { hlReg.set('lsp-link', hlReg.get('lsp-hover')); hlReg.delete('lsp-hover'); } });
  addEventListener('keyup', e => { if ((e.key === 'Meta' || e.key === 'Control') && hlReg?.has('lsp-link')) { hlReg.set('lsp-hover', hlReg.get('lsp-link')); hlReg.delete('lsp-link'); } });

  const viewFor = l => { const n = nodeOf(l.repo, l.path); return n && n.status !== 'N' && n.status !== 'D' && S.fullDiff && S.view === 'diff' ? 'diff' : 'new'; };
  function jumpTo(l) {
    if (!l.repo) return copy(`${l.file}:${l.range.start.line + 1}`, 'Outside the board, path copied');
    openFile(l.repo, l.path, { view: viewFor(l), side: 'new', lines: [l.range.start.line + 1, l.range.end.line + 1] });
  }

  async function goDefinition(pos) {
    hideTip(true);
    const r = await lspReq('definition', pos);
    const locs = r.locations ?? [];
    if (!locs.length) return r.error ? toast(r.error) : toast(`No definition found for ${pos.word}`);
    if (locs.length === 1 && locs[0].repo) return jumpTo(locs[0]);
    showLocations(`Definitions of <code>${esc(pos.word)}</code>`, locs);
  }

  async function findReferences(pos) {
    hideTip(true);
    $('#refs').hidden = false;
    $('#refs').innerHTML = `<div class="refshead"><span>Finding references to <code>${esc(pos.word)}</code>…</span></div>`;
    const r = await lspReq('references', pos);
    if (r.error) { $('#refs').innerHTML = `<div class="refshead"><span>${esc(r.error)}</span><span class="spacer"></span><button class="ib" data-refs="close" aria-label="Close">✕</button></div>`; return; }
    showLocations(`References to <code>${esc(pos.word)}</code>`, r.locations ?? []);
  }

  /* results list under the code, grouped by file; files on the graph that hold a result light up */
  function showLocations(title, locs) {
    S.refs = locs;
    const files = new Map();
    locs.forEach((l, i) => { const k = l.repo ? `${l.repo}:${l.path}` : l.file; if (!files.has(k)) files.set(k, []); files.get(k).push(i); });
    const row = i => {
      const l = locs[i], t = l.text ?? '', a = l.range.start.character, b = l.range.start.line === l.range.end.line ? l.range.end.character : t.length;
      const lead = t.length - t.trimStart().length;
      return `<li data-ref="${i}"><span class="no">${l.range.start.line + 1}</span><code>${esc(t.slice(lead, a))}<mark>${esc(t.slice(a, b))}</mark>${esc(t.slice(b).trimEnd())}</code></li>`;
    };
    $('#refs').hidden = false;
    $('#refs').innerHTML = `<div class="refshead"><span>${title} · ${locs.length} in ${files.size} file${files.size === 1 ? '' : 's'}</span><span class="spacer"></span><button class="ib" data-refs="close" title="Close (Esc)" aria-label="Close">✕</button></div>
      <div class="refsbody">${[...files].map(([k, is]) => { const l = locs[is[0]]; return `<div class="reffile${l.repo ? '' : ' ext'}"><b>${esc(l.repo ? l.path.split('/').pop() : k.split('/').pop())}</b> <span class="meta">${esc(l.repo ? `${l.repo}:${l.path.split('/').slice(0, -1).join('/')}` : k)}</span> <span class="meta">${is.length}</span></div><ul>${is.map(row).join('')}</ul>`; }).join('') || '<div class="meta" style="padding:8px 12px">Nothing found.</div>'}</div>`;
    S.cy.batch(() => {
      S.cy.nodes('.refhit').removeClass('refhit');
      for (const l of locs) if (l.repo) S.cy.getElementById(`${l.repo}:${l.path}`).addClass('refhit');
    });
  }
  function closeRefs() { $('#refs').hidden = true; S.refs = null; S.cy?.nodes('.refhit').removeClass('refhit'); }
  $('#refs').addEventListener('click', e => {
    if (e.target.closest('[data-refs="close"]')) return closeRefs();
    const li = e.target.closest('[data-ref]');
    if (li) { $('#refs').querySelectorAll('li.cur').forEach(x => x.classList.remove('cur')); li.classList.add('cur'); jumpTo(S.refs[Number(li.dataset.ref)]); }
  });

  addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'F12' && S.lspSym && lspOn()) { e.preventDefault(); return e.shiftKey ? findReferences(S.lspSym) : goDefinition(S.lspSym); }
    if ((e.ctrlKey && !e.shiftKey && e.key === '-') || (e.altKey && e.key === 'ArrowLeft')) { e.preventDefault(); return navBack(); }
    if ((e.ctrlKey && (e.key === '_' || (e.shiftKey && e.key === '-'))) || (e.altKey && e.key === 'ArrowRight')) { e.preventDefault(); return history.forward(); }
    if (e.key === 'Escape' && !$('#lspTip').hidden) return hideTip(true);
    if (e.key === 'Escape' && !$('#refs').hidden) return closeRefs();
  });

  /* ---------------- line selection & references ---------------- */
  function selectLine(cell, extend) {
    const side = cell.dataset.side, n = Number(cell.dataset.n);
    if (extend && S.sel && S.sel.side === side) { S.sel.start = Math.min(S.sel.anchor ?? S.sel.start, n); S.sel.end = Math.max(S.sel.anchor ?? S.sel.start, n); }
    else S.sel = { side, start: n, end: n, anchor: n };
    setHash();
    paintSel(cell);
  }

  function paintSel(nearCell) {
    document.querySelectorAll('.code .sel, .code .selc').forEach(x => x.classList.remove('sel', 'selc'));
    const bar = $('#selbar');
    if (!S.sel || S.open?.kind !== 'file') { bar.hidden = true; return; }
    const { side, start, end } = S.sel;
    const split = !!document.querySelector('.code table.split');
    let anchor = null;
    document.querySelectorAll(`.code tr[data-${side}]`).forEach(tr => {
      const n = Number(tr.dataset[side]);
      if (n >= start && n <= end) {
        if (split) tr.querySelectorAll(`td[data-side="${side}"]`).forEach(td => td.classList.add('selc'));
        else tr.classList.add('sel');
        if (n === end) anchor = tr;
      }
    });
    const ref = lineRef();
    bar.innerHTML = `<code title="${esc(ref)}">${esc(ref)}</code>
      <button class="btn primary" data-sel="ref" title="Paste into a chat: the agent can open these exact lines">Copy reference</button>
      <button class="btn" data-sel="link" title="Link that opens the board on these lines">Copy board link</button>
      ${side === 'new' ? '<button class="btn" data-sel="note">Note on lines</button>' : ''}
      <button class="btn ghost" data-sel="clear" aria-label="Clear selection">✕</button>`;
    bar.hidden = false;
    const panel = $('#panel').getBoundingClientRect();
    bar.style.top = `${window.innerHeight - bar.offsetHeight - 14}px`;
    bar.style.left = `${panel.left + 12}px`;
    bar.style.maxWidth = `${panel.width - 24}px`;
  }

  const absPath = () => `${repoOf(S.open.repo)?.path}/${S.open.path}`;
  function lineRef() {
    const { side, start, end } = S.sel;
    const lines = start === end ? `${start}` : `${start}-${end}`;
    if (side === 'new') return `${absPath()}:${lines}`;
    const n = nodeOf(S.open.repo, S.open.path);
    const r = repoOf(S.open.repo);
    return `${r?.path}/${n?.oldPath ?? S.open.path}:${lines} (at base ${r?.mergeBase})`;
  }
  const boardLink = () => `${location.origin}/${location.pathname === '/' ? '' : ''}#${hashFor()}`;

  $('#selbar').addEventListener('click', e => {
    const a = e.target.closest('[data-sel]')?.dataset.sel;
    if (a === 'ref') copy(lineRef(), 'Reference copied');
    if (a === 'link') copy(boardLink(), 'Board link copied');
    if (a === 'note') { const { start, end } = S.sel; createNote({ title: `${base(S.open.path)}:${start}${end !== start ? '-' + end : ''}`, links: [`${S.open.repo}:${S.open.path}:${start}-${end}`] }); }
    if (a === 'clear') { S.sel = null; setHash(); paintSel(); }
  });

  /* the panel shows the whole file; open it at the first change, with a few lines of context above */
  function scrollToFirstChange() {
    const code = $('#fileView .code');
    const first = code?.querySelector('tr.add, tr.del, td.c.add, td.c.del');
    if (!first) return;
    const row = first.closest('tr');
    code.scrollTop = Math.max(0, row.getBoundingClientRect().top - code.getBoundingClientRect().top + code.scrollTop - Math.min(120, code.clientHeight / 4));
  }

  function scrollToSel(flash) {
    if (!S.sel) return;
    const tr = document.querySelector(`.code tr[data-${S.sel.side}="${S.sel.start}"]`);
    if (!tr) return;
    tr.scrollIntoView({ block: 'center' });
    if (flash) tr.classList.add('flash');
    paintSel(tr.querySelector('td'));
  }

  /* ---------------- notes ---------------- */
  async function createNote({ title, body = '', links = [] }) {
    try {
      const n = await post(`${B()}/notes`, { title, body, links, author: 'you' });
      await refresh();
      openNote(n.id, true);
    } catch (e) { toast(e.message); }
  }

  async function openNote(id, edit = false, opts = {}) {
    if (S.pane === 'graph') setPane('both');
    if (S.fedit) await endEdit(false);
    const newNode = !(S.open?.kind === 'note' && S.open.id === id);
    if (newNode && !opts.fromNav) rememberScroll();
    S.open = { kind: 'note', id };
    S.editing = edit;
    S.sel = null; paintSel();
    setHash(newNode && !opts.fromNav);
    S.focusOff = false;
    await renderNote();
    if (opts.scroll != null) { const b = $('#noteBodyView'); if (b) b.scrollTop = opts.scroll; }
    S.cy.$(':selected').unselect(); S.cy.getElementById(`note:${id}`).select();
    applyFocus(true);
  }

  const linkText = l => `${l.repo ?? l.repoPath}:${l.path}${l.start ? ':' + l.start + (l.end && l.end !== l.start ? '-' + l.end : '') : ''}`;

  /* mermaid reads quoted labels as markdown and rejects lists and headings ("Unsupported markdown: list"),
     so "1. Roles" or "- item" at the start of a label line gets a non-breaking space after its marker */
  const mermaidSafe = src => src.replace(/"[^"\n]*"/g, q => q.replace(/(^"|<br\s*\/?>)(\s*)(\d+[.)]|[-*+]|#{1,6}) /gi, '$1$2$3\u00a0'))
    // links with an empty label ("A -. .-> B", "A -- --> B", "A == ==> B") are a syntax error: drop the label
    .replace(/(^|\s)-\.\s+\.->/gm, '$1-.->').replace(/(^|\s)--\s+-->/gm, '$1-->').replace(/(^|\s)==\s+==>/gm, '$1==>');

  // re-rendering resets diagrams, so an open note is redrawn only when it actually changed
  const noteSig = () => { const n = S.data?.notes.find(x => x.id === S.open?.id); return n ? `${n.id}|${n.updatedAt}|${n.links.map(l => l.repo).join()}` : ''; };

  async function renderNote() {
    S.noteSig = noteSig();
    const note = S.data?.notes.find(n => n.id === S.open.id);
    const view = $('#noteView');
    $('#placeholder').hidden = true; $('#fileView').hidden = true; view.hidden = false;
    if (!note) { view.innerHTML = '<div class="notebody meta">This note no longer exists.</div>'; return; }
    const linkList = `<ul class="links">${note.links.map((l, i) => `<li><a data-open-link="${i}">${esc(linkText(l))}</a>${l.repo ? '' : ' <span class="meta">(repo not watched)</span>'} <button class="btn ghost" data-unlink="${i}" title="Remove link">✕</button></li>`).join('') || '<li class="meta">Not linked to any file yet.</li>'}</ul>`;
    const canLink = S.lastFile && !note.links.some(l => l.repo === S.lastFile.repo && l.path === S.lastFile.path);
    if (S.editing) {
      view.innerHTML = `<div class="phead"><div class="prow"><span class="badge N">note</span><span>${esc(note.title)}</span></div><div class="prow"><span class="meta">Editing</span><span class="spacer"></span><button class="btn" data-n="cancel">Cancel</button><button class="btn primary" data-n="save">Save</button></div></div>
        <div class="notebody"><input type="text" id="noteTitle" value="${esc(note.title)}" aria-label="Title"><p class="meta">Markdown. Diagrams: a fenced block starting with <code>\`\`\`mermaid</code>.</p>
        <textarea id="noteBody" aria-label="Body">${esc(note.body)}</textarea><h4>Linked files</h4>${linkList}</div>`;
      $('#noteBody').focus();
      return;
    }
    view.innerHTML = `<div class="phead"><div class="prow"><span class="badge N">note</span><span>${esc(note.title)}</span></div><div class="prow"><span class="meta">${esc(note.author)} · updated ${ago(note.updatedAt)}</span><span class="spacer"></span>
        ${canLink ? `<button class="btn" data-n="link" title="Link ${esc(S.lastFile.path)}">Link ${esc(base(S.lastFile.path))}</button>` : ''}
        <button class="btn" data-n="copy" title="Board link to this note">Copy link</button><button class="btn" data-n="edit">Edit</button><button class="btn danger" data-n="delete">Delete</button></div>
        ${linkList}</div>
      <div class="notebody" id="noteBodyView"></div>`;
    await renderMarkdown($('#noteBodyView'), note.body || '*Empty note.*', note.id);
  }

  /* markdown of notes and .md files: sanitized (repo files can carry any HTML), mermaid fences drawn as
     zoomable diagrams; with a file context, relative images load from the repo and .md links open in the panel */
  async function renderMarkdown(el, md, key, file) {
    const html = window.marked ? marked.parse(md) : `<pre>${esc(md)}</pre>`;
    el.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : esc(md);
    if (file) {
      const dir = file.path.split('/').slice(0, -1).join('/');
      const rel = href => decodeURIComponent(new URL(href, `http://x/${dir ? dir + '/' : ''}`).pathname.slice(1));
      const local = href => href && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);
      el.querySelectorAll('img[src]').forEach(img => {
        const src = img.getAttribute('src');
        if (local(src)) img.src = `${B()}/raw?repo=${encodeURIComponent(file.repo)}&path=${encodeURIComponent(rel(src))}`;
      });
      el.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        if (local(href)) { a.dataset.mdLink = rel(href.split('#')[0]); a.removeAttribute('href'); a.title = a.dataset.mdLink; }
        else if (!href.startsWith('#')) { a.target = '_blank'; a.rel = 'noopener'; }
      });
    }
    const blocks = [...el.querySelectorAll('pre code.language-mermaid')];
    for (const code of blocks) { const div = document.createElement('div'); div.className = 'mermaid'; div.textContent = mermaidSafe(code.textContent); code.parentElement.replaceWith(div); }
    if (blocks.length && window.mermaid) {
      // a broken diagram shows its error and source; the others still render
      const ok = [];
      for (const div of el.querySelectorAll('.mermaid')) {
        try { await mermaid.parse(div.textContent); ok.push(div); }
        catch (e) {
          const box = document.createElement('div');
          box.className = 'dgerror';
          box.innerHTML = `<div class="dgerrhead">Diagram error</div><pre class="dgerrmsg">${esc(String(e?.message ?? e).trim())}</pre><details><summary>Source</summary><pre><code>${esc(div.textContent)}</code></pre></details>`;
          div.replaceWith(box);
        }
      }
      if (ok.length) { try { await mermaid.run({ nodes: ok }); } catch (e) { console.warn(e); } }
    }
    el.querySelectorAll('.mermaid').forEach((div, i) => panZoom(div, `${key}:${i}`));
  }
  const isMd = path => /\.(md|mdx|markdown)$/i.test(path);

  /* ---------------- diagrams: zoom (ctrl/⌘ + wheel, pinch, buttons) and drag to move ---------------- */
  const dgViews = new Map(); // `${noteId}:${index}` -> { k, x, y }, kept across re-renders
  function panZoom(div, key) {
    const svg = div.querySelector('svg');
    if (!svg) return;
    const vb = svg.viewBox?.baseVal;
    const W = vb?.width || svg.getBoundingClientRect().width, H = vb?.height || svg.getBoundingClientRect().height;
    svg.removeAttribute('style'); svg.setAttribute('width', W); svg.setAttribute('height', H);
    const box = document.createElement('div');
    box.className = 'diagram';
    box.innerHTML = `<div class="dgview"><div class="dgstage"></div></div>
      <div class="dgtools"><button class="ib" data-dg="out" title="Zoom out (−)" aria-label="Zoom out">−</button><button class="dgpct" data-dg="fit" title="Fit (0, or double-click the diagram)"></button><button class="ib" data-dg="in" title="Zoom in (+)" aria-label="Zoom in">+</button>
      <button class="ib" data-dg="full" title="Fullscreen (f, Esc closes)" aria-label="Fullscreen"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg></button></div>`;
    div.replaceWith(box);
    const view = box.querySelector('.dgview'), stage = box.querySelector('.dgstage');
    stage.append(div);
    let t = dgViews.get(key);
    const apply = () => {
      // zoom resizes the SVG itself, so the browser redraws the vectors crisply; the transform only moves it
      svg.setAttribute('width', W * t.k); svg.setAttribute('height', H * t.k);
      stage.style.transform = `translate(${t.x}px, ${t.y}px)`;
      box.querySelector('.dgpct').textContent = `${Math.round(t.k * 100)}%`;
      dgViews.set(key, t);
    };
    const fit = () => {
      const vw = view.clientWidth, vh = view.clientHeight, pad = 16;
      const k = Math.min(box.classList.contains('full') ? 4 : 1, (vw - 2 * pad) / W, (vh - 2 * pad) / H);
      t = { k, x: (vw - W * k) / 2, y: (vh - H * k) / 2 };
      apply();
    };
    const zoomAt = (factor, px, py) => {
      const k = Math.min(8, Math.max(0.1, t.k * factor));
      t = { k, x: px - (px - t.x) * (k / t.k), y: py - (py - t.y) * (k / t.k) };
      apply();
    };
    const centre = () => [view.clientWidth / 2, view.clientHeight / 2];
    // inline: as tall as the diagram at fit-to-width, within reason
    view.style.height = `${Math.round(Math.max(160, Math.min(H * Math.min(1, (view.clientWidth - 32) / W) + 32, innerHeight * 0.6)))}px`;
    if (t) apply(); else fit();

    view.addEventListener('wheel', e => {
      const full = box.classList.contains('full');
      // inline, a plain wheel keeps scrolling the note; pinch and ctrl/⌘ zoom; fullscreen, the wheel moves the diagram
      if (!(e.ctrlKey || e.metaKey) && !full) return;
      e.preventDefault();
      const r = view.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top);
      else { t = { ...t, x: t.x - e.deltaX, y: t.y - e.deltaY }; apply(); }
    }, { passive: false });
    let drag = null;
    view.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      box.focus({ preventScroll: true });
      drag = { x: e.clientX, y: e.clientY };
      view.setPointerCapture(e.pointerId);
      view.classList.add('dragging');
    });
    view.addEventListener('pointermove', e => {
      if (!drag) return;
      t = { ...t, x: t.x + e.clientX - drag.x, y: t.y + e.clientY - drag.y };
      drag = { x: e.clientX, y: e.clientY };
      apply();
    });
    const end = () => { drag = null; view.classList.remove('dragging'); };
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
    view.addEventListener('dblclick', fit);
    const setFull = on => {
      box.classList.toggle('full', on);
      document.body.classList.toggle('dgfull', on);
      requestAnimationFrame(fit);
      if (on) box.focus();
    };
    box.tabIndex = -1;
    box.addEventListener('click', e => {
      const a = e.target.closest('[data-dg]')?.dataset.dg;
      if (a === 'in') zoomAt(1.25, ...centre());
      if (a === 'out') zoomAt(0.8, ...centre());
      if (a === 'fit') fit();
      if (a === 'full') setFull(!box.classList.contains('full'));
    });
    box.addEventListener('keydown', e => {
      const act = { '+': () => zoomAt(1.25, ...centre()), '=': () => zoomAt(1.25, ...centre()), '-': () => zoomAt(0.8, ...centre()), 0: fit, f: () => setFull(!box.classList.contains('full')), Escape: () => box.classList.contains('full') && setFull(false) }[e.key];
      if (!act) return;
      e.preventDefault(); e.stopPropagation();
      act();
    });
  }

  $('#noteView').addEventListener('click', async e => {
    const id = S.open?.id;
    const note = S.data?.notes.find(n => n.id === id);
    const act = e.target.closest('[data-n]')?.dataset.n;
    const ol = e.target.closest('[data-open-link]');
    if (ol) { const l = note.links[Number(ol.dataset.openLink)]; if (l.repo) openFile(l.repo, l.path, l.start ? { lines: [l.start, l.end ?? l.start], side: 'new', view: nodeOf(l.repo, l.path)?.status === 'N' ? 'new' : 'diff' } : {}); return; }
    const un = e.target.closest('[data-unlink]');
    if (un) { const l = note.links[Number(un.dataset.unlink)]; await post(`${B()}/notes/${id}`, { removeLinks: [l.repo ? linkText(l) : `${l.repoPath}/${l.path}${l.start ? ':' + l.start + '-' + (l.end ?? l.start) : ''}`], author: 'you' }, 'PATCH').catch(err => toast(err.message)); return refresh(); }
    if (act === 'edit') { S.editing = true; return renderNote(); }
    if (act === 'cancel') { S.editing = false; return renderNote(); }
    if (act === 'save') { await post(`${B()}/notes/${id}`, { title: $('#noteTitle').value, body: $('#noteBody').value, author: 'you' }, 'PATCH'); S.editing = false; return refresh(); }
    if (act === 'delete') { if (!e.target.dataset.confirm) { e.target.dataset.confirm = '1'; e.target.textContent = 'Click again to delete'; return; } await api(`${B()}/notes/${id}`, { method: 'DELETE' }); S.open = null; $('#noteView').hidden = true; $('#placeholder').hidden = false; setHash(); return refresh(); }
    if (act === 'copy') return copy(noteLink(id), 'Note link copied');
    if (act === 'link') { await post(`${B()}/notes/${id}`, { addLinks: [`${S.lastFile.repo}:${S.lastFile.path}`], author: 'you' }, 'PATCH'); return refresh(); }
  });

  /* ---------------- review order ---------------- */
  const isReviewed = id => !!S.data?.review?.reviewed.includes(id);
  const currentTour = () => S.data?.review?.tours.find(t => t.name === S.tour) ?? null;

  /** The agent's tour first (if one is chosen), then every other changed file in dependency order. */
  function reviewItems() {
    const rv = S.data?.review;
    if (!rv) return [];
    const items = [];
    const inTour = new Set();
    for (const s of currentTour()?.steps ?? []) { items.push({ step: true, ...s }); if (s.id) inTour.add(s.id); }
    for (const id of rv.order) {
      const n = !inTour.has(id) && S.data.nodes.find(x => x.id === id);
      if (n) items.push({ step: false, id, repo: n.repo, path: n.path, changed: true });
    }
    return items;
  }

  function syncRvIdx(items) {
    if (S.open?.kind !== 'file') return;
    const openId = `${S.open.repo}:${S.open.path}`;
    if (items[S.rvIdx]?.id === openId) return;
    const i = items.findIndex(it => it.id === openId);
    if (i >= 0) S.rvIdx = i;
  }

  function renderReview() {
    const rv = S.data?.review;
    if (!rv) return;
    if (S.tour && !rv.tours.some(t => t.name === S.tour)) S.tour = '';
    const total = rv.order.length;
    const done = rv.order.filter(isReviewed).length;
    $('#reviewProgress').textContent = total ? `${done}/${total}` : '';
    $('#rvCount').textContent = total ? `${done} of ${total} files` : 'nothing changed';
    $('#rvBar').style.width = total ? `${(done / total) * 100}%` : '0';
    $('#rvTour').innerHTML = [['', 'Automatic: dependencies first'], ...rv.tours.map(t => [t.name, `Tour “${t.name}” · ${t.steps.length} steps · ${t.author}`])]
      .map(([v, l]) => `<option value="${esc(v)}"${v === S.tour ? ' selected' : ''}>${esc(l)}</option>`).join('');
    if (!S.reviewOpen) return;
    const items = reviewItems();
    syncRvIdx(items);
    let html = '', sec = null;
    items.forEach((it, i) => {
      if (S.tour && it.step !== sec) html += `<li class="sec">${it.step ? `Tour “${esc(S.tour)}”` : 'Other changed files'}</li>`;
      sec = it.step;
      const lines = it.start ? `:${it.start}${it.end && it.end !== it.start ? `-${it.end}` : ''}` : '';
      const dir = it.path.split('/').slice(0, -1).join('/');
      const ok = it.changed && isReviewed(it.id);
      html += `<li class="it${i === S.rvIdx ? ' cur' : ''}${ok ? ' done' : ''}${it.repo ? '' : ' gone'}" data-rv="${i}" title="${esc(it.repo ?? 'repo not watched')}:${esc(it.path)}">
        ${it.changed ? `<input type="checkbox" data-rv-check="${esc(it.id)}"${ok ? ' checked' : ''} aria-label="Reviewed">` : '<span></span>'}
        <span class="no">${i + 1}</span><span class="nm">${esc(base(it.path))}<span class="ln">${lines}</span></span>
        <span class="dir">${esc(it.repo ?? '?')} · ${esc(dir)}</span>${it.note ? `<span class="why">${esc(it.note)}</span>` : ''}</li>`;
    });
    $('#rvList').innerHTML = html || '<li class="sec">No changed files.</li>';
    $('#rvList .cur')?.scrollIntoView({ block: 'nearest' });
  }

  function goReview(i) {
    const items = reviewItems();
    if (!items.length) return;
    S.rvIdx = Math.max(0, Math.min(items.length - 1, i));
    const it = items[S.rvIdx];
    if (!it.repo) { renderReview(); return toast('That repository is not watched'); }
    openFile(it.repo, it.path, it.start ? { view: 'new', side: 'new', lines: [it.start, it.end ?? it.start] } : { view: it.changed ? 'diff' : 'new' });
  }
  const stepReview = d => { syncRvIdx(reviewItems()); goReview(S.rvIdx + d); };

  async function setReviewed(id, on) {
    const n = S.data.nodes.find(x => x.id === id);
    if (!n) return;
    try { await post(`${B()}/reviewed`, { repo: n.repo, path: n.path, reviewed: on }); }
    catch (e) { return toast(e.message); }
    const r = S.data.review.reviewed;
    S.data.review.reviewed = on ? [...new Set([...r, id])] : r.filter(x => x !== id);
    renderReview();
  }

  /* x: mark the current file reviewed and jump to the next one still waiting */
  async function reviewAndNext() {
    const items = reviewItems();
    syncRvIdx(items);
    const cur = items[S.rvIdx];
    if (cur?.changed && !isReviewed(cur.id)) await setReviewed(cur.id, true);
    const pending = (it, i) => i > S.rvIdx && (!it.changed || !isReviewed(it.id));
    let i = items.findIndex(pending);
    if (i < 0) i = items.findIndex(it => it.changed && !isReviewed(it.id));
    if (i < 0) return toast('Everything is reviewed');
    goReview(i);
  }

  function setReviewOpen(open) {
    S.reviewOpen = open;
    $('#review').hidden = !open;
    $('#reviewToggle').setAttribute('aria-pressed', String(open));
    try { localStorage.setItem('diffboard.reviewOpen', open ? '1' : '0'); } catch {}
    renderReview();
    requestAnimationFrame(() => { S.cy?.resize(); syncCards(); paintSel(); });
  }
  function setTour(name) {
    S.tour = name; S.rvIdx = -1;
    try { localStorage.setItem('diffboard.tour', name); } catch {}
    setHash(); renderReview();
  }
  $('#reviewToggle').addEventListener('click', () => setReviewOpen(!S.reviewOpen));
  $('#reviewClose').addEventListener('click', () => setReviewOpen(false));
  $('#rvTour').addEventListener('change', e => setTour(e.target.value));
  $('#rvList').addEventListener('click', e => {
    const chk = e.target.closest('[data-rv-check]');
    if (chk) return setReviewed(chk.dataset.rvCheck, chk.checked);
    const li = e.target.closest('[data-rv]');
    if (li) goReview(Number(li.dataset.rv));
  });

  /* ---------------- routing ---------------- */
  function hashFor() {
    const p = new URLSearchParams();
    if (S.board !== 'default') p.set('board', S.board);
    if (S.open?.kind === 'note') p.set('note', S.open.id);
    if (S.open?.kind === 'file') {
      p.set('file', `${S.open.repo}:${S.open.path}`); p.set('view', S.view);
      if (S.sel) { p.set('lines', S.sel.start === S.sel.end ? `${S.sel.start}` : `${S.sel.start}-${S.sel.end}`); p.set('side', S.sel.side); }
    }
    if (S.tour) p.set('tour', S.tour);
    return p.toString();
  }
  /* history: opening a file, note or board is an entry (back/forward walk them); selections and views only update it */
  function setHash(push = false) {
    const h = hashFor();
    if (location.hash.slice(1) === h) return;
    const url = h ? `#${h}` : location.pathname;
    push ? history.pushState({ idx: (history.state?.idx ?? 0) + 1 }, '', url) : history.replaceState(history.state, '', url);
  }
  // the scroll position of the place being left, restored when history comes back to it
  function rememberScroll() {
    const el = S.open?.kind === 'note' ? $('#noteBodyView') : S.open?.kind === 'file' ? $('#fileView .code') : null;
    if (el) history.replaceState({ ...(history.state ?? {}), scroll: el.scrollTop }, '');
  }
  async function routeFromHash(fromNav = true) {
    const p = new URLSearchParams(location.hash.slice(1));
    const board = p.get('board') || 'default';
    // a board created moments ago may not be in the list yet
    if (board !== S.board && !S.boards.some(b => b.id === board)) await loadBoards().catch(() => {});
    if (board !== S.board && S.boards.some(b => b.id === board)) await switchBoard(board, fromNav);
    if (p.get('tour') && p.get('tour') !== S.tour) {
      setTour(p.get('tour')); setReviewOpen(true);
      if (!p.get('file') && !p.get('note')) return goReview(0);
    }
    if (p.get('expand') === 'all') { for (const n of S.data.nodes) if (expandable(n)) S.expanded.add(n.id); persistExpanded(); renderCards(S.data).then(() => { layout(true); syncCards(); }); }
    const scroll = history.state?.scroll;
    if (p.get('note')) return openNote(p.get('note'), false, { fromNav, scroll });
    const f = p.get('file');
    if (!f) {
      // an entry with nothing open: back to the empty panel
      if (S.open) { if (S.fedit) await endEdit(false); S.open = null; S.sel = null; paintSel(); $('#fileView').hidden = true; $('#noteView').hidden = true; $('#placeholder').hidden = false; applyFocus(); }
      return;
    }
    const i = f.indexOf(':');
    const lines = p.get('lines')?.split('-').map(Number);
    openFile(f.slice(0, i), f.slice(i + 1), { fromNav, scroll, view: p.get('view') || undefined, side: p.get('side') || 'new', lines: lines ? [lines[0], lines[1] ?? lines[0]] : undefined });
  }
  // the board's own back never walks off the board into whatever page came before it
  function navBack() { if ((history.state?.idx ?? 0) > 0) history.back(); else toast('Start of history'); }
  // back/forward, and hash edits typed into the address bar, both arrive here
  window.addEventListener('popstate', () => { if (location.hash.slice(1) !== hashFor()) routeFromHash(true); });
  // mouse side buttons, handled here so the page never leaves the board
  addEventListener('mouseup', e => { if (e.button === 3 || e.button === 4) { e.preventDefault(); e.button === 3 ? navBack() : history.forward(); } });
  $('#navBack').addEventListener('click', navBack);
  $('#navFwd').addEventListener('click', () => history.forward());

  /* ---------------- data loop ---------------- */
  async function refresh() {
    const board = S.board;
    const data = await api(`${B()}/state`);
    if (board !== S.board) return; // switched while loading
    S.data = data;
    renderStatus(data);
    renderTop(data);
    await syncGraph(data);
    renderActivity(data);
    renderReview();
    if (S.dockTab === 'files') { loadFiles().then(renderTree).catch(() => {}); }
    if (S.open?.kind === 'file') {
      const n = nodeOf(S.open.repo, S.open.path);
      if (S.fedit) { renderFile(false); reloadEditor(false); }
      else if (sigOf(n) !== S.openSig) await loadFile(false);
      else renderFile(false);
    } else if (S.open?.kind === 'note' && !S.editing && noteSig() !== S.noteSig) renderNote();
  }

  function connect() {
    const es = new EventSource('/events');
    es.onopen = () => $('#live').classList.add('on');
    es.onerror = () => $('#live').classList.remove('on');
    let pending = false;
    let boardsPending = false;
    const boardsSoon = () => { if (boardsPending) return; boardsPending = true; setTimeout(() => { boardsPending = false; loadBoards().catch(console.error); }, 400); };
    es.addEventListener('change', e => {
      boardsSoon();
      let board = null; try { board = JSON.parse(e.data).board; } catch {}
      if (board && board !== S.board) return;
      $('#live').classList.add('flash'); setTimeout(() => $('#live').classList.remove('flash'), 400);
      if (pending) return; pending = true;
      setTimeout(() => { pending = false; refresh().catch(console.error); }, 120);
    });
    es.addEventListener('boards', boardsSoon);
  }

  /* recent-change glow fades without a server event */
  setInterval(() => {
    if (!S.cy || !S.data) return;
    const now = Date.now();
    S.cy.nodes('.file').forEach(n => { const d = S.data.nodes.find(x => x.id === n.id()); n.toggleClass('recent', !!(d?.changedAt && now - d.changedAt < 12000)); });
  }, 2000);

  /* panel resizer */
  (() => {
    const rz = $('#resizer'), panel = $('#panel');
    try { const w = localStorage.getItem('diffboard.panel'); if (w) panel.style.width = w; } catch {}
    rz.addEventListener('pointerdown', e => {
      rz.setPointerCapture(e.pointerId);
      const move = ev => { panel.style.width = `${Math.min(window.innerWidth - 320, Math.max(360, window.innerWidth - ev.clientX))}px`; S.cy?.resize(); };
      const up = () => { rz.removeEventListener('pointermove', move); try { localStorage.setItem('diffboard.panel', panel.style.width); } catch {} };
      rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up, { once: true });
    });
  })();

  /* pane modes */
  function setPane(mode, persist = true) {
    S.pane = mode;
    const l = document.querySelector('.layout');
    l.classList.remove('pane-graph', 'pane-both', 'pane-panel');
    l.classList.add(`pane-${mode}`);
    document.querySelectorAll('#paneMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pane === mode)));
    if (persist) try { localStorage.setItem('diffboard.pane', mode); } catch {}
    requestAnimationFrame(() => { S.cy?.resize(); syncCards(); paintSel(); });
  }
  $('#paneMode').addEventListener('click', e => { const b = e.target.closest('[data-pane]'); if (b) setPane(b.dataset.pane); });
  /* ✕ and the backslash key hide the panel; the key brings it back to the mode it was closed from */
  let paneBeforeClose = 'both';
  function togglePanel() {
    if (S.pane === 'graph') return setPane(paneBeforeClose);
    paneBeforeClose = S.pane;
    setPane('graph');
  }
  $('#panelClose').addEventListener('click', togglePanel);
  /* keys: \\ panel · r review sidebar · j/k next/previous in the review order · x reviewed & next */
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input:not([type=checkbox]), textarea, select, [contenteditable]')) return;
    const act = { '\\': togglePanel, r: () => setReviewOpen(!S.reviewOpen), b: () => setBoardsOpen(!S.boardsOpen), p: () => openQuick(), j: () => stepReview(1), k: () => stepReview(-1), x: reviewAndNext, e: () => { if (S.open?.kind === 'file' && !S.fedit) $('#fileView [data-act="edit"]')?.click(); } }[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  });
  setReviewOpen(S.reviewOpen);
  let savedPane = 'both'; try { savedPane = localStorage.getItem('diffboard.pane') || 'both'; } catch {}
  setPane(savedPane, false);

  /* middle mouse button pans the graph anywhere on the canvas, cards included */
  (() => {
    const wrap = $('.canvasWrap');
    let last = null;
    wrap.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); }, true);
    wrap.addEventListener('pointerdown', e => {
      if (e.button !== 1) return;
      e.preventDefault(); e.stopPropagation();
      last = { x: e.clientX, y: e.clientY };
      wrap.setPointerCapture(e.pointerId);
      wrap.classList.add('panning');
    }, true);
    wrap.addEventListener('pointermove', e => {
      if (!last) return;
      S.cy.panBy({ x: e.clientX - last.x, y: e.clientY - last.y });
      last = { x: e.clientX, y: e.clientY };
    });
    const end = e => { if (!last) return; last = null; wrap.classList.remove('panning'); try { wrap.releasePointerCapture(e.pointerId); } catch {} };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    wrap.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
  })();

  initGraph();
  // node labels are drawn on canvas: redraw once the web font has arrived
  document.fonts?.ready.then(() => S.cy?.style().update());
  setBoardsOpen(S.boardsOpen);
  setDockTab(S.dockTab);
  document.querySelectorAll('#graphMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.graph === S.graphMode)));
  $('#showNeighbours').closest('label').hidden = S.graphMode === 'map';
  loadBoards().then(refresh).then(() => { routeFromHash(); connect(); }).catch(e => { $('#empty').hidden = false; $('#empty').textContent = e.message; });
})();
