/**
 * Design boards: the data model, process and assumptions of a solution, agreed on before any code
 * is written. Everything changes through operations (`Op`), never by editing the document directly,
 * so a change has an author, can be replayed, previewed as a proposal and undone.
 * This file is pure: no IO, so the server, the CLI and the tests share it.
 */

export type Role = 'edit' | 'propose' | 'read';
export type CrudOp = 'C' | 'R' | 'U' | 'D';
export type AssumptionStatus = 'accepted' | 'open' | 'question' | 'rejected';
export type Severity = 'error' | 'warn' | 'off';

export interface Ref { table: string; column: string }
export interface Column {
  name: string;
  type: string;
  nullable?: boolean;
  pk?: boolean;
  unique?: boolean;
  default?: string;
  ref?: Ref;            // foreign key; `fk: false` keeps the reference logical (no constraint)
  fk?: boolean;
  note?: string;
}
export interface Table {
  name: string;
  module?: string;
  kind?: 'table' | 'view';
  note?: string;
  columns: Column[];
  samples?: Record<string, string>[];
  x?: number; y?: number;
}
export interface Enum { name: string; values: string[] }
export interface Touch { table: string; op: CrudOp; columns?: string[] }
export interface Step {
  id: string;
  title: string;
  lane?: string;
  trigger?: string;
  note?: string;
  touches: Touch[];
  x?: number; y?: number;
}
export interface Flow { from: string; to: string; label?: string }
export interface Transition { from: string; to: string; step?: string; label?: string }
export interface Machine { table: string; column: string; states: string[]; transitions: Transition[]; x?: number; y?: number }
export interface Assumption { id: string; text: string; status: AssumptionStatus; author?: string; x?: number; y?: number }
export interface Comment { id: string; author: string; text: string; at: number; target?: string }
export interface Proposal {
  id: string;
  title: string;
  rationale?: string;
  author: string;
  ops: Op[];
  status: 'open' | 'accepted' | 'rejected';
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
}
export interface Participant { name: string; role: Role; joinedAt: number; lastSeen?: number }
export interface ModuleDef { name: string; kind: 'module' | 'platform'; path?: string }
export interface Rules {
  /** a foreign key from one business module to another (platform is shared, so it is fine) */
  crossModuleFk: Severity;
  /** columns every table of a business module must have, e.g. ["team_id"] */
  requiredColumns: string[];
}
export interface Approval { version: number; at: number; by: string; rev: number }

export interface Design {
  format: 1;
  id: string;
  name: string;
  purpose?: string;
  rev: number;                 // bumps on every applied batch of operations
  approved?: Approval;         // the last approved version
  draft?: boolean;             // true once the model changed after the last approval
  processY?: number;           // top of the process lanes; kept below the data model by reflow()
  modules: ModuleDef[];
  rules: Rules;
  tables: Table[];
  enums: Enum[];
  lanes: string[];
  steps: Step[];
  flows: Flow[];
  machines: Machine[];
  assumptions: Assumption[];
  proposals: Proposal[];
  comments: Comment[];
  participants: Participant[];
}

export type Op =
  | { op: 'set-design'; name?: string; purpose?: string }
  | { op: 'add-module'; name: string; kind?: 'module' | 'platform'; path?: string }
  | { op: 'remove-module'; name: string }
  | { op: 'set-rules'; crossModuleFk?: Severity; requiredColumns?: string[] }
  | { op: 'add-table'; table: string; module?: string; kind?: 'table' | 'view'; note?: string; columns?: Column[]; x?: number; y?: number }
  | { op: 'set-table'; table: string; name?: string; module?: string | null; kind?: 'table' | 'view'; note?: string | null }
  | { op: 'remove-table'; table: string }
  | { op: 'add-column'; table: string; column: Column; after?: string }
  | { op: 'set-column'; table: string; column: string; name?: string; type?: string; nullable?: boolean; pk?: boolean; unique?: boolean; default?: string | null; ref?: Ref | null; fk?: boolean; note?: string | null }
  | { op: 'remove-column'; table: string; column: string }
  | { op: 'set-samples'; table: string; rows: Record<string, string>[] }
  | { op: 'set-enum'; name: string; values: string[] }
  | { op: 'remove-enum'; name: string }
  | { op: 'add-lane'; name: string }
  | { op: 'remove-lane'; name: string }
  | { op: 'add-step'; id?: string; title: string; lane?: string; trigger?: string; note?: string; touches?: Touch[]; after?: string; x?: number; y?: number }
  | { op: 'set-step'; id: string; title?: string; lane?: string; trigger?: string | null; note?: string | null; touches?: Touch[] }
  | { op: 'remove-step'; id: string }
  | { op: 'add-flow'; from: string; to: string; label?: string }
  | { op: 'remove-flow'; from: string; to: string }
  | { op: 'set-machine'; table: string; column: string; states: string[]; transitions?: Transition[] }
  | { op: 'remove-machine'; table: string; column: string }
  | { op: 'add-assumption'; id?: string; text: string; status?: AssumptionStatus; x?: number; y?: number }
  | { op: 'set-assumption'; id: string; text?: string; status?: AssumptionStatus }
  | { op: 'remove-assumption'; id: string }
  | { op: 'move'; kind: 'table' | 'step' | 'assumption' | 'machine'; id: string; x: number; y: number }
  | { op: 'arrange' };

export const OP_NAMES = ['set-design', 'add-module', 'remove-module', 'set-rules', 'add-table', 'set-table', 'remove-table', 'add-column', 'set-column', 'remove-column', 'set-samples', 'set-enum', 'remove-enum', 'add-lane', 'remove-lane', 'add-step', 'set-step', 'remove-step', 'add-flow', 'remove-flow', 'set-machine', 'remove-machine', 'add-assumption', 'set-assumption', 'remove-assumption', 'move', 'arrange'] as const;

export class OpError extends Error {}

export function emptyDesign(id: string, name: string): Design {
  return {
    format: 1, id, name, rev: 0,
    modules: [], rules: { crossModuleFk: 'error', requiredColumns: [] },
    tables: [], enums: [], lanes: [], steps: [], flows: [], machines: [], assumptions: [],
    proposals: [], comments: [], participants: [],
  };
}

export const clone = <T>(v: T): T => structuredClone(v);

const IDENT = /^[A-Za-z_][\w]*$/;
function ident(kind: string, v: unknown): string {
  const s = String(v ?? '').trim();
  if (!IDENT.test(s)) throw new OpError(`${kind} "${s}" is not a valid name (letters, digits, _)`);
  return s;
}
const text = (v: unknown, kind: string) => { const s = String(v ?? '').trim(); if (!s) throw new OpError(`${kind} is required`); return s; };

function table(d: Design, name: string) {
  const t = d.tables.find(x => x.name === name);
  if (!t) throw new OpError(`no table ${name}`);
  return t;
}
function column(t: Table, name: string) {
  const c = t.columns.find(x => x.name === name);
  if (!c) throw new OpError(`no column ${t.name}.${name}`);
  return c;
}
function step(d: Design, id: string) {
  const s = d.steps.find(x => x.id === id);
  if (!s) throw new OpError(`no step ${id}`);
  return s;
}
function nextId(prefix: string, taken: string[]) {
  let n = 1;
  for (const id of taken) { const m = new RegExp(`^${prefix}(\\d+)$`).exec(id); if (m) n = Math.max(n, Number(m[1]) + 1); }
  return `${prefix}${n}`;
}
function cleanColumn(c: Column): Column {
  const out: Column = { name: ident('column', c.name), type: text(c.type, `type of ${c.name}`) };
  if (c.nullable) out.nullable = true;
  if (c.pk) out.pk = true;
  if (c.unique) out.unique = true;
  if (c.default !== undefined && c.default !== null && c.default !== '') out.default = String(c.default);
  if (c.ref) out.ref = { table: ident('table', c.ref.table), column: ident('column', c.ref.column) };
  if (c.ref && c.fk === false) out.fk = false;
  if (c.note) out.note = String(c.note);
  return out;
}
const touches = (list: Touch[] = []) => list.map(t => {
  const op = String(t.op).toUpperCase();
  if (!['C', 'R', 'U', 'D'].includes(op)) throw new OpError(`touch op must be C, R, U or D, not ${t.op}`);
  const out: Touch = { table: ident('table', t.table), op: op as CrudOp };
  if (t.columns?.length) out.columns = t.columns.map(c => ident('column', c));
  return out;
});

/* ---------- placement: a new item without coordinates lands next to its kind ---------- */
// The canvas draws with the same numbers (ui/design.js): keep them in step.
export const TABLE_W = 260, SAMPLE_W = 112, MAX_SAMPLES = 2, ROW_H = 22, HEAD_H = 34;
const TABLE_GAP = 60, MODULE_GAP = 160, COLUMN_MAX = 900, STICKY_W = 220;
/** A table shows up to two sample rows as extra columns to the right of the types. */
export const tableWidth = (t: Table) => TABLE_W + Math.min(MAX_SAMPLES, t.samples?.length ?? 0) * SAMPLE_W;
/** Header, the columns and the "+ column" row. */
export const tableHeight = (t: Table) => HEAD_H + (t.columns.length + 1) * ROW_H + 4;
/** A sticky grows with its text: about 31 characters a 17.5px line at 12px; 29 leaves room for word wrap. */
export function stickyHeight(a: Assumption) {
  const lines = a.text.split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(p.length / 29)), 0);
  return Math.ceil(44 + lines * 17.5 + (a.author ? 18 : 0));
}
type Box = { x: number; y: number; w: number; h: number };
const hit = (a: Box, b: Box, pad = 40) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
const tableBox = (t: Table): Box => ({ x: t.x!, y: t.y!, w: tableWidth(t), h: tableHeight(t) });
const machineBox = (m: Machine): Box => ({ x: m.x!, y: m.y!, ...machineSize(m) });
const stickyBox = (a: Assumption): Box => ({ x: a.x!, y: a.y!, w: STICKY_W, h: stickyHeight(a) });
/** Everything already on the canvas a new table must not cover. */
function occupied(d: Design, t: Table): Box[] {
  const out: Box[] = [];
  for (const o of d.tables) if (o !== t && o.x !== undefined) out.push(tableBox(o));
  for (const a of d.assumptions) if (a.x !== undefined) out.push(stickyBox(a));
  for (const m of d.machines) if (m.x !== undefined) out.push(machineBox(m));
  // the process runs in lanes across the whole width
  if (d.steps.length || d.lanes.length) out.push({ x: -1e6, y: processTop(d) - 40, w: 2e6, h: Math.max(1, d.lanes.length) * LANE_H + 80 });
  return out;
}
/**
 * Next to the tables of its module, in the first spot that covers nothing; a module's column
 * wraps into a new one past COLUMN_MAX, other modules keep their own columns.
 */
function placeTable(d: Design, t: Table) {
  const taken = occupied(d, t);
  const mates = d.tables.filter(x => x !== t && x.x !== undefined && (x.module ?? '') === (t.module ?? ''));
  const others = d.tables.filter(x => x !== t && x.x !== undefined && (x.module ?? '') !== (t.module ?? ''));
  const h = tableHeight(t), w = tableWidth(t);
  const free = (x: number, y: number) => !taken.some(b => hit({ x, y, w, h }, b))
    // a module's column never slides into another module's frame
    && !others.some(o => x < o.x! + tableWidth(o) + 80 && o.x! < x + w + 80);
  const tries: [number, number][] = [];
  if (mates.length) {
    const top = Math.min(...mates.map(m => m.y!));
    const cols = [...new Set(mates.map(m => m.x!))].sort((a, b) => a - b);
    for (const x of cols) {
      const y = Math.max(...mates.filter(m => m.x === x).map(m => m.y! + tableHeight(m))) + TABLE_GAP;
      if (y + h <= top + COLUMN_MAX) tries.push([x, y]);
    }
    const right = Math.max(...mates.map(m => m.x! + tableWidth(m)));
    for (let i = 0; i < 4; i++) tries.push([right + TABLE_GAP + i * (TABLE_W + TABLE_GAP), top]);
  }
  for (const [x, y] of tries) if (free(x, y)) { t.x = x; t.y = y; return; }
  // a new module (or a full one): right of everything that is there
  const edge = Math.max(-TABLE_W - MODULE_GAP, ...taken.filter(b => b.w < 1e5).map(b => b.x + b.w));
  t.x = d.tables.some(x => x !== t && x.x !== undefined) || taken.some(b => b.w < 1e5) ? edge + MODULE_GAP : 0;
  t.y = mates.length ? Math.min(...mates.map(m => m.y!)) : 0;
  while (!free(t.x, t.y) && t.y < processTop(d)) t.y += 60;
  if (!free(t.x, t.y)) { t.y = mates.length ? Math.min(...mates.map(m => m.y!)) : 0; t.x += TABLE_W + MODULE_GAP; }
}
export const PROCESS_TOP = 900, LANE_H = 120, STEP_W = 180, STEP_GAP = 50;
export const processTop = (d: Design) => d.processY ?? PROCESS_TOP;
/** Same geometry the canvas draws a state machine with: up to three states per row. */
export function machineSize(m: Machine) {
  const per = Math.min(3, m.states.length), rows = Math.ceil(m.states.length / per);
  return { w: 48 + (per - 1) * 160 + 116, h: 58 + (rows - 1) * 78 + 30 };
}
const snap = (v: number) => Math.ceil(v / 20) * 20;
/** Moves the process lanes (and their steps) so they start at `top`. */
function moveProcess(d: Design, top: number) {
  const dy = top - processTop(d);
  if (!dy) return;
  d.processY = top;
  for (const s of d.steps) if (s.y !== undefined) s.y += dy;
}
/** Bottom edge of everything above the process. */
function contentBottom(d: Design) {
  return Math.max(-Infinity,
    ...d.tables.filter(t => t.y !== undefined).map(t => t.y! + tableHeight(t)),
    ...d.machines.filter(m => m.y !== undefined).map(m => m.y! + machineSize(m).h),
    ...d.assumptions.filter(a => a.y !== undefined).map(a => a.y! + stickyHeight(a)));
}
/**
 * Keeps the canvas readable after every change: nothing above the process covers anything else
 * (a table that grew, for instance by its sample rows, pushes what is to its right further right),
 * and the process runs in lanes across the whole width, under everything else.
 */
export function reflow(d: Design) {
  untangle(d);
  if (!d.steps.length && !d.lanes.length) return;
  const need = contentBottom(d) + 80;
  if (need > processTop(d)) moveProcess(d, processTop(d) + snap(need - processTop(d)));
}
/**
 * Pushes overlapping items apart: within one column the lower item moves down with everything
 * under it, otherwise the right one moves right with everything right of it.
 */
function untangle(d: Design) {
  type It = { box: () => Box; move: (dx: number, dy: number) => void };
  const mover = (o: { x?: number; y?: number }) => (dx: number, dy: number) => { o.x! += dx; o.y! += dy; };
  const items: It[] = [
    ...d.tables.filter(t => t.x !== undefined).map(t => ({ box: () => tableBox(t), move: mover(t) })),
    ...d.machines.filter(m => m.x !== undefined).map(m => ({ box: () => machineBox(m), move: mover(m) })),
    ...d.assumptions.filter(a => a.x !== undefined).map(a => ({ box: () => stickyBox(a), move: mover(a) })),
  ];
  for (let pass = 0; pass < 300; pass++) {
    let moved = false;
    const sorted = [...items].sort((a, b) => a.box().x - b.box().x || a.box().y - b.box().y);
    outer: for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i].box(), b = sorted[j].box();
      if (!hit(a, b, 0)) continue;
      if (Math.abs(a.x - b.x) < 10) {
        const dy = a.y + a.h + 24 - b.y;
        for (const it of items) { const c = it.box(); if (Math.abs(c.x - b.x) < 10 && c.y >= b.y) it.move(0, dy); }
      } else {
        const dx = snap(a.x + a.w + 40 - b.x);
        for (const it of items) if (it.box().x >= b.x) it.move(dx, 0);
      }
      moved = true; break outer;
    }
    if (!moved) return;
  }
}
/** Tables of one module in reading order: a referenced table before the ones pointing at it, unrelated tables last. */
function fkOrder(ts: Table[]) {
  const by = new Map(ts.map(t => [t.name, t]));
  const linked = new Set<string>();
  for (const t of ts) for (const c of t.columns) if (c.ref && by.has(c.ref.table) && c.ref.table !== t.name) { linked.add(t.name); linked.add(c.ref.table); }
  const out: Table[] = [], seen = new Set<string>();
  const visit = (t: Table) => {
    if (seen.has(t.name)) return; seen.add(t.name);
    for (const c of t.columns) if (c.ref && by.has(c.ref.table)) visit(by.get(c.ref.table)!);
    out.push(t);
  };
  for (const t of ts) if (linked.has(t.name)) visit(t);
  for (const t of ts) visit(t);
  return out;
}
/**
 * Lays the whole board out again: each module a frame of balanced columns (tables in reference
 * order), the modules side by side, state machines and then the assumptions to their right,
 * the process underneath. Only coordinates change.
 */
export function arrange(d: Design) {
  const mods = [...new Set([...d.modules.map(m => m.name), ...d.tables.map(t => t.module ?? '')])];
  let x = 0;
  for (const mod of mods) {
    const ts = fkOrder(d.tables.filter(t => (t.module ?? '') === mod));
    if (!ts.length) continue;
    const total = ts.reduce((n, t) => n + tableHeight(t) + TABLE_GAP, -TABLE_GAP);
    const tallest = Math.max(...ts.map(tableHeight));
    const target = Math.max(tallest, total / Math.ceil(total / Math.max(COLUMN_MAX, tallest)));
    const cols: Table[][] = [[]];
    let y = 0;
    for (const t of ts) {
      if (cols[cols.length - 1].length && y + tableHeight(t) > target + 60) { cols.push([]); y = 0; }
      cols[cols.length - 1].push(t);
      t.y = y; y += tableHeight(t) + TABLE_GAP;
    }
    for (const col of cols) {
      for (const t of col) t.x = x;
      x += Math.max(...col.map(tableWidth)) + TABLE_GAP;
    }
    x += MODULE_GAP - TABLE_GAP;
  }
  if (d.machines.length) {
    let y = 0;
    for (const m of d.machines) { m.x = x; m.y = y; y += machineSize(m).h + 60; }
    x += Math.max(...d.machines.map(m => machineSize(m).w)) + 120;
  }
  // stickies in as many columns as keep them about as tall as the data model, each next one under the shortest column
  const dataH = Math.max(COLUMN_MAX, ...d.tables.map(t => t.y! + tableHeight(t)), ...d.machines.map(m => m.y! + machineSize(m).h));
  const total = d.assumptions.reduce((n, a) => n + stickyHeight(a) + 24, 0);
  const colY = Array.from({ length: Math.max(2, Math.ceil(total / dataH)) }, () => 0);
  for (const a of d.assumptions) {
    const c = colY.indexOf(Math.min(...colY));
    a.x = x + c * (STICKY_W + 30); a.y = colY[c]; colY[c] += stickyHeight(a) + 24;
  }
  if (d.steps.length || d.lanes.length) {
    d.processY = snap(Math.max(0, contentBottom(d)) + 120);
    arrangeProcess(d);
  }
}
/**
 * Steps left to right in flow order: a step stands right of every step that leads to it (loops
 * back are ignored), in its own lane, and never on top of another step of that lane.
 */
function arrangeProcess(d: Design) {
  const order: Step[] = [], seen = new Set<string>();
  const byId = new Map(d.steps.map(s => [s.id, s]));
  const visit = (s: Step) => {
    if (seen.has(s.id)) return; seen.add(s.id); order.push(s);
    for (const f of d.flows) if (f.from === s.id && byId.has(f.to)) visit(byId.get(f.to)!);
  };
  for (const s of d.steps) if (!d.flows.some(f => f.to === s.id && byId.has(f.from))) visit(s);
  for (const s of d.steps) visit(s);
  const idx = new Map(order.map((s, i) => [s.id, i]));
  const pitch = STEP_W + STEP_GAP, laneEnd = new Map<number, number>(), x = new Map<string, number>();
  for (const s of order) {
    const lane = Math.max(0, d.lanes.indexOf(s.lane ?? ''));
    const preds = d.flows.filter(f => f.to === s.id && idx.has(f.from) && idx.get(f.from)! < idx.get(s.id)!).map(f => x.get(f.from)! + pitch);
    const sx = Math.max(160, laneEnd.get(lane) ?? 0, ...preds);
    x.set(s.id, sx); laneEnd.set(lane, sx + pitch);
    s.x = sx; s.y = processTop(d) + lane * LANE_H + 30;
  }
}

function placeStep(d: Design, s: Step, after?: string) {
  const lane = Math.max(0, d.lanes.indexOf(s.lane ?? ''));
  const prev = after ? d.steps.find(x => x.id === after) : undefined;
  const x = prev?.x !== undefined ? prev.x + STEP_W + STEP_GAP : Math.max(-1, ...d.steps.filter(x => x !== s && x.x !== undefined).map(x => x.x!)) + STEP_W + STEP_GAP;
  s.x = Math.max(160, x); s.y = processTop(d) + lane * LANE_H + 30;
}
/** Under the other stickies, in the shorter of their two columns. */
function placeAssumption(d: Design, a: Assumption) {
  const placed = d.assumptions.filter(x => x !== a && x.x !== undefined);
  if (!placed.length) {
    const right = Math.max(0, ...d.tables.filter(t => t.x !== undefined).map(t => t.x! + tableWidth(t)), ...d.machines.filter(m => m.x !== undefined).map(m => m.x! + machineSize(m).w));
    a.x = right + 120; a.y = 0; return;
  }
  const x0 = Math.min(...placed.map(p => p.x!)), y0 = Math.min(...placed.map(p => p.y!));
  const bottom = (x: number) => Math.max(y0, ...placed.filter(p => Math.abs(p.x! - x) < STICKY_W / 2).map(p => p.y! + stickyHeight(p) + 24));
  const [x, y] = [x0, x0 + STICKY_W + 30].map(cx => [cx, bottom(cx)]).sort((p, q) => p[1] - q[1])[0];
  a.x = x; a.y = y;
}

/** Applies one operation in place. Throws OpError when it does not fit the current design. */
export function applyOp(d: Design, op: Op, author = 'you') {
  switch (op.op) {
    case 'set-design': if (op.name !== undefined) d.name = text(op.name, 'name'); if (op.purpose !== undefined) d.purpose = op.purpose || undefined; return;
    case 'add-module': {
      const name = ident('module', op.name);
      const m = d.modules.find(x => x.name === name);
      if (m) { if (op.kind) m.kind = op.kind; if (op.path !== undefined) m.path = op.path || undefined; return; }
      d.modules.push({ name, kind: op.kind ?? 'module', ...(op.path ? { path: op.path } : {}) });
      return;
    }
    case 'remove-module': {
      if (d.tables.some(t => t.module === op.name)) throw new OpError(`module ${op.name} still has tables`);
      d.modules = d.modules.filter(m => m.name !== op.name);
      return;
    }
    case 'set-rules': {
      if (op.crossModuleFk) d.rules.crossModuleFk = op.crossModuleFk;
      if (op.requiredColumns) d.rules.requiredColumns = op.requiredColumns.map(c => ident('column', c));
      return;
    }
    case 'add-table': {
      const name = ident('table', op.table);
      if (d.tables.some(t => t.name === name)) throw new OpError(`table ${name} already exists`);
      const t: Table = { name, columns: [] };
      if (op.module) { t.module = ident('module', op.module); if (!d.modules.some(m => m.name === t.module)) d.modules.push({ name: t.module, kind: 'module' }); }
      if (op.kind === 'view') t.kind = 'view';
      if (op.note) t.note = op.note;
      for (const c of op.columns ?? []) { const cc = cleanColumn(c); if (t.columns.some(x => x.name === cc.name)) throw new OpError(`column ${name}.${cc.name} given twice`); t.columns.push(cc); }
      d.tables.push(t);
      if (typeof op.x === 'number' && typeof op.y === 'number') { t.x = op.x; t.y = op.y; } else placeTable(d, t);
      return;
    }
    case 'set-table': {
      const t = table(d, op.table);
      if (op.module !== undefined) {
        if (op.module) { t.module = ident('module', op.module); if (!d.modules.some(m => m.name === t.module)) d.modules.push({ name: t.module, kind: 'module' }); }
        else delete t.module;
      }
      if (op.kind) { if (op.kind === 'view') t.kind = 'view'; else delete t.kind; }
      if (op.note !== undefined) { if (op.note) t.note = op.note; else delete t.note; }
      if (op.name && op.name !== t.name) renameTable(d, t, ident('table', op.name));
      return;
    }
    case 'remove-table': {
      const t = table(d, op.table);
      const users = d.tables.filter(x => x !== t && x.columns.some(c => c.ref?.table === t.name)).map(x => x.name);
      if (users.length) throw new OpError(`table ${t.name} is referenced by ${users.join(', ')}; remove those references first`);
      d.tables = d.tables.filter(x => x !== t);
      for (const s of d.steps) s.touches = s.touches.filter(x => x.table !== t.name);
      d.machines = d.machines.filter(m => m.table !== t.name);
      return;
    }
    case 'add-column': {
      const t = table(d, op.table);
      const c = cleanColumn(op.column);
      if (t.columns.some(x => x.name === c.name)) throw new OpError(`column ${t.name}.${c.name} already exists`);
      const i = op.after ? t.columns.findIndex(x => x.name === op.after) : -1;
      if (op.after && i < 0) throw new OpError(`no column ${t.name}.${op.after}`);
      if (i >= 0) t.columns.splice(i + 1, 0, c); else t.columns.push(c);
      return;
    }
    case 'set-column': {
      const t = table(d, op.table);
      const c = column(t, op.column);
      if (op.type !== undefined) c.type = text(op.type, 'type');
      for (const k of ['nullable', 'pk', 'unique'] as const) if (op[k] !== undefined) { if (op[k]) c[k] = true; else delete c[k]; }
      if (op.default !== undefined) { if (op.default === null || op.default === '') delete c.default; else c.default = String(op.default); }
      if (op.note !== undefined) { if (op.note) c.note = op.note; else delete c.note; }
      if (op.ref !== undefined) { if (op.ref) c.ref = { table: ident('table', op.ref.table), column: ident('column', op.ref.column) }; else { delete c.ref; delete c.fk; } }
      if (op.fk !== undefined && c.ref) { if (op.fk === false) c.fk = false; else delete c.fk; }
      if (op.name && op.name !== c.name) {
        const to = ident('column', op.name);
        if (t.columns.some(x => x.name === to)) throw new OpError(`column ${t.name}.${to} already exists`);
        for (const x of d.tables) for (const cc of x.columns) if (cc.ref?.table === t.name && cc.ref.column === c.name) cc.ref.column = to;
        for (const s of d.steps) for (const tt of s.touches) if (tt.table === t.name && tt.columns) tt.columns = tt.columns.map(n => n === c.name ? to : n);
        for (const m of d.machines) if (m.table === t.name && m.column === c.name) m.column = to;
        for (const row of t.samples ?? []) if (c.name in row) { row[to] = row[c.name]; delete row[c.name]; }
        c.name = to;
      }
      return;
    }
    case 'remove-column': {
      const t = table(d, op.table);
      const c = column(t, op.column);
      const users = d.tables.flatMap(x => x.columns.filter(cc => cc.ref?.table === t.name && cc.ref.column === c.name).map(cc => `${x.name}.${cc.name}`));
      if (users.length) throw new OpError(`${t.name}.${c.name} is referenced by ${users.join(', ')}`);
      t.columns = t.columns.filter(x => x !== c);
      for (const s of d.steps) for (const tt of s.touches) if (tt.table === t.name && tt.columns) tt.columns = tt.columns.filter(n => n !== c.name);
      d.machines = d.machines.filter(m => !(m.table === t.name && m.column === c.name));
      for (const row of t.samples ?? []) delete row[c.name];
      return;
    }
    case 'set-samples': {
      const t = table(d, op.table);
      if (!Array.isArray(op.rows)) throw new OpError('rows must be a list of objects');
      t.samples = op.rows.map(r => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, String(v)])));
      if (!t.samples.length) delete t.samples;
      return;
    }
    case 'set-enum': {
      const name = ident('enum', op.name);
      const values = (op.values ?? []).map(v => text(v, 'enum value'));
      if (!values.length) throw new OpError(`enum ${name} needs values`);
      const e = d.enums.find(x => x.name === name);
      if (e) e.values = values; else d.enums.push({ name, values });
      return;
    }
    case 'remove-enum': d.enums = d.enums.filter(e => e.name !== op.name); return;
    case 'add-lane': { const n = text(op.name, 'lane'); if (!d.lanes.includes(n)) d.lanes.push(n); return; }
    case 'remove-lane': {
      if (d.steps.some(s => s.lane === op.name)) throw new OpError(`lane ${op.name} still has steps`);
      d.lanes = d.lanes.filter(l => l !== op.name);
      return;
    }
    case 'add-step': {
      const id = op.id ? ident('step', op.id) : nextId('S', d.steps.map(s => s.id));
      if (d.steps.some(s => s.id === id)) throw new OpError(`step ${id} already exists`);
      const s: Step = { id, title: text(op.title, 'title'), touches: touches(op.touches) };
      if (op.lane) { s.lane = text(op.lane, 'lane'); if (!d.lanes.includes(s.lane)) d.lanes.push(s.lane); }
      if (op.trigger) s.trigger = op.trigger;
      if (op.note) s.note = op.note;
      d.steps.push(s);
      if (op.after) { step(d, op.after); d.flows.push({ from: op.after, to: id }); }
      if (typeof op.x === 'number' && typeof op.y === 'number') { s.x = op.x; s.y = op.y; } else placeStep(d, s, op.after);
      return;
    }
    case 'set-step': {
      const s = step(d, op.id);
      if (op.title !== undefined) s.title = text(op.title, 'title');
      if (op.lane !== undefined) {
        s.lane = text(op.lane, 'lane');
        if (!d.lanes.includes(s.lane)) d.lanes.push(s.lane);
        s.y = processTop(d) + d.lanes.indexOf(s.lane) * LANE_H + 30;
      }
      if (op.trigger !== undefined) { if (op.trigger) s.trigger = op.trigger; else delete s.trigger; }
      if (op.note !== undefined) { if (op.note) s.note = op.note; else delete s.note; }
      if (op.touches) s.touches = touches(op.touches);
      return;
    }
    case 'remove-step': {
      const s = step(d, op.id);
      d.steps = d.steps.filter(x => x !== s);
      d.flows = d.flows.filter(f => f.from !== s.id && f.to !== s.id);
      for (const m of d.machines) for (const t of m.transitions) if (t.step === s.id) delete t.step;
      return;
    }
    case 'add-flow': {
      step(d, op.from); step(d, op.to);
      if (op.from === op.to) throw new OpError('a flow needs two different steps');
      const f = d.flows.find(x => x.from === op.from && x.to === op.to);
      if (f) { if (op.label !== undefined) f.label = op.label || undefined; return; }
      d.flows.push({ from: op.from, to: op.to, ...(op.label ? { label: op.label } : {}) });
      return;
    }
    case 'remove-flow': d.flows = d.flows.filter(f => !(f.from === op.from && f.to === op.to)); return;
    case 'set-machine': {
      const t = table(d, op.table); column(t, op.column);
      const states = [...new Set((op.states ?? []).map(s => text(s, 'state')))];
      if (states.length < 2) throw new OpError('a state machine needs at least two states');
      const transitions = (op.transitions ?? []).map(tr => {
        if (!states.includes(tr.from) || !states.includes(tr.to)) throw new OpError(`transition ${tr.from} → ${tr.to} uses an unknown state`);
        return { from: tr.from, to: tr.to, ...(tr.step ? { step: tr.step } : {}), ...(tr.label ? { label: tr.label } : {}) };
      });
      const m = d.machines.find(x => x.table === t.name && x.column === op.column);
      if (m) { m.states = states; m.transitions = transitions; }
      else {
        const right = Math.max(0, ...d.tables.map(x => (x.x ?? 0) + tableWidth(x)), ...d.assumptions.map(a => (a.x ?? 0) + STICKY_W));
        const below = Math.max(0, ...d.machines.filter(x => (x.x ?? 0) >= right).map(x => x.y! + machineSize(x).h + 40));
        d.machines.push({ table: t.name, column: op.column, states, transitions, x: right + 120, y: below });
      }
      return;
    }
    case 'remove-machine': d.machines = d.machines.filter(m => !(m.table === op.table && m.column === op.column)); return;
    case 'add-assumption': {
      const id = op.id ? ident('assumption', op.id) : nextId('A', d.assumptions.map(a => a.id));
      if (d.assumptions.some(a => a.id === id)) throw new OpError(`assumption ${id} already exists`);
      const a: Assumption = { id, text: text(op.text, 'text'), status: op.status ?? 'open', author };
      d.assumptions.push(a);
      if (typeof op.x === 'number' && typeof op.y === 'number') { a.x = op.x; a.y = op.y; } else placeAssumption(d, a);
      return;
    }
    case 'set-assumption': {
      const a = d.assumptions.find(x => x.id === op.id);
      if (!a) throw new OpError(`no assumption ${op.id}`);
      if (op.text !== undefined) a.text = text(op.text, 'text');
      if (op.status) a.status = op.status;
      return;
    }
    case 'remove-assumption': d.assumptions = d.assumptions.filter(a => a.id !== op.id); return;
    case 'move': {
      const x = Math.round(Number(op.x)), y = Math.round(Number(op.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new OpError('move needs numeric x and y');
      const target = op.kind === 'table' ? table(d, op.id)
        : op.kind === 'step' ? step(d, op.id)
        : op.kind === 'assumption' ? d.assumptions.find(a => a.id === op.id)
        : d.machines.find(m => `${m.table}.${m.column}` === op.id);
      if (!target) throw new OpError(`no ${op.kind} ${op.id}`);
      target.x = x; target.y = y;
      return;
    }
    case 'arrange': arrange(d); return;
    default: throw new OpError(`unknown op ${(op as { op: string }).op}`);
  }
}

function renameTable(d: Design, t: Table, to: string) {
  if (d.tables.some(x => x.name === to)) throw new OpError(`table ${to} already exists`);
  for (const x of d.tables) for (const c of x.columns) if (c.ref?.table === t.name) c.ref.table = to;
  for (const s of d.steps) for (const tt of s.touches) if (tt.table === t.name) tt.table = to;
  for (const m of d.machines) if (m.table === t.name) m.table = to;
  t.name = to;
}

/** Applies a batch atomically: either every op fits, or the design is left untouched. */
export function applyOps(d: Design, ops: Op[], author = 'you'): Design {
  if (!Array.isArray(ops) || !ops.length) throw new OpError('no operations');
  const next = clone(d);
  ops.forEach((op, i) => {
    try { applyOp(next, op, author); }
    catch (e) { throw new OpError(ops.length > 1 ? `op ${i + 1} (${op?.op}): ${(e as Error).message}` : (e as Error).message); }
  });
  reflow(next);
  return next;
}

/** Whether an op only rearranges the canvas: those never turn an approved version into a draft. */
export const layoutOnly = (ops: Op[]) => ops.every(o => o.op === 'move' || o.op === 'arrange');

/* ---------- what a batch of operations changes: drives the proposal preview ---------- */
export interface DesignDiff {
  tables: { added: string[]; removed: string[]; changed: string[] };
  columns: { added: string[]; removed: string[]; changed: string[] };   // "table.column"
  steps: { added: string[]; removed: string[]; changed: string[] };
  assumptions: { added: string[]; removed: string[]; changed: string[] };
  machines: { added: string[]; removed: string[]; changed: string[] };  // "table.column"
  enums: { added: string[]; removed: string[]; changed: string[] };
}
function keyed<T>(a: T[], b: T[], key: (x: T) => string, strip: (x: T) => unknown = x => x) {
  const A = new Map(a.map(x => [key(x), x])), B = new Map(b.map(x => [key(x), x]));
  return {
    added: [...B.keys()].filter(k => !A.has(k)),
    removed: [...A.keys()].filter(k => !B.has(k)),
    changed: [...B.keys()].filter(k => A.has(k) && JSON.stringify(strip(A.get(k)!)) !== JSON.stringify(strip(B.get(k)!))),
  };
}
const noPos = <T extends { x?: number; y?: number }>(x: T) => { const { x: _x, y: _y, ...rest } = x; return rest; };
export function diffDesigns(a: Design, b: Design): DesignDiff {
  const cols = (d: Design) => d.tables.flatMap(t => t.columns.map(c => ({ ...c, key: `${t.name}.${c.name}` })));
  return {
    tables: keyed(a.tables, b.tables, t => t.name, t => ({ ...noPos(t), columns: undefined })),
    columns: keyed(cols(a), cols(b), c => c.key),
    steps: keyed(a.steps, b.steps, s => s.id, noPos),
    assumptions: keyed(a.assumptions, b.assumptions, x => x.id, noPos),
    machines: keyed(a.machines, b.machines, m => `${m.table}.${m.column}`, noPos),
    enums: keyed(a.enums, b.enums, e => e.name),
  };
}
