import { unwatchFile, watchFile } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { applyOps, clone, diffDesigns, emptyDesign, layoutOnly, OpError, type Design, type Op, type Proposal, type Role } from './model';
import { check } from './rules';

/** Where one design lives: a text file in the project repo, so it travels with the branch and the PR. */
export interface DesignEntry { id: string; file: string }
interface Live { d: Design; file: string; text: string; undo: { rev: number; before: Design; author: string }[]; watcher?: { close(): void }; seen: Map<string, number> }

const MODEL_KEYS = ['name', 'purpose', 'modules', 'rules', 'tables', 'enums', 'lanes', 'steps', 'flows', 'machines', 'assumptions'] as const;
const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design';
export const designFile = (repoRoot: string, id: string, dir = 'docs/boards') => join(repoRoot, dir, `${id}.board.json`);
const sideDir = (file: string) => join(dirname(file), basename(file, '.board.json'));

export class DesignStore {
  private live = new Map<string, Live>();
  private listeners = new Set<(e: { design: string; rev: number }) => void>();
  constructor(private indexFile: string) {}

  async load() {
    let entries: DesignEntry[] = [];
    try { entries = JSON.parse(await readFile(this.indexFile, 'utf8')); } catch { /* first run */ }
    for (const e of entries) {
      try { await this.attach(e.file); } catch (err) { console.error(`design ${e.id}: ${(err as Error).message}`); }
    }
  }

  private async saveIndex() {
    await mkdir(dirname(this.indexFile), { recursive: true });
    await writeFile(this.indexFile, JSON.stringify([...this.live.values()].map(l => ({ id: l.d.id, file: l.file })), null, 2));
  }

  onChange(fn: (e: { design: string; rev: number }) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private proposalListeners = new Set<(d: Design, p: Proposal) => void>();
  /** A new proposal waits for the user: the server pushes it to the phone. */
  onProposal(fn: (d: Design, p: Proposal) => void) { this.proposalListeners.add(fn); return () => this.proposalListeners.delete(fn); }
  private emit(l: Live) { for (const fn of this.listeners) fn({ design: l.d.id, rev: l.d.rev }); }

  private async attach(file: string) {
    const raw = await readFile(file, 'utf8');
    const d = normalize(JSON.parse(raw));
    if (this.live.has(d.id) && this.live.get(d.id)!.file !== file) throw new Error(`a design with id ${d.id} is already open from ${this.live.get(d.id)!.file}`);
    this.live.get(d.id)?.watcher?.close();
    const l: Live = { d, file, text: raw, undo: [], seen: new Map() };
    this.live.set(d.id, l);
    this.watchFile(l);
    return l;
  }

  /** A checkout or pull rewrites the file: take the version on disk. Polled: fs events miss renames. */
  private watchFile(l: Live) {
    const onChange = async () => {
      try {
        const raw = await readFile(l.file, 'utf8');
        if (raw === l.text) return;
        l.d = normalize(JSON.parse(raw));
        l.text = raw;
        l.undo = [];
        this.emit(l);
      } catch { /* half-written or removed: keep what we have */ }
    };
    watchFile(l.file, { interval: 700, persistent: false }, onChange);
    l.watcher = { close: () => unwatchFile(l.file, onChange) };
  }

  private async persist(l: Live, history?: Record<string, unknown>) {
    const raw = JSON.stringify(l.d, null, 2) + '\n';
    await mkdir(dirname(l.file), { recursive: true });
    const tmp = `${l.file}.tmp-${process.pid}`;
    await writeFile(tmp, raw);
    l.text = raw;
    await rename(tmp, l.file);
    if (history) {
      await mkdir(sideDir(l.file), { recursive: true });
      await appendFile(join(sideDir(l.file), 'history.jsonl'), JSON.stringify({ rev: l.d.rev, at: Date.now(), ...history }) + '\n');
    }
    this.emit(l);
  }

  private need(id: string) {
    const l = this.live.get(id) ?? [...this.live.values()].find(x => x.d.name === id);
    if (!l) throw new OpError(`no design ${id} (diffboard design list)`);
    return l;
  }

  list() {
    return [...this.live.values()].map(l => ({
      id: l.d.id, name: l.d.name, file: l.file, rev: l.d.rev,
      version: l.d.approved?.version ?? 0, draft: !l.d.approved || !!l.d.draft,
      tables: l.d.tables.length, steps: l.d.steps.length, assumptions: l.d.assumptions.length,
      openProposals: l.d.proposals.filter(p => p.status === 'open').length,
      participants: l.d.participants.map(p => p.name),
    }));
  }

  get(id: string) { return this.need(id).d; }
  file(id: string) { return this.need(id).file; }

  /** The design with what the canvas needs on top: findings and who is around right now. */
  view(id: string) {
    const l = this.need(id);
    const now = Date.now();
    return {
      design: l.d, file: l.file, findings: check(l.d),
      presence: [...l.seen.entries()].filter(([, at]) => now - at < 120_000).map(([name, at]) => ({ name, at })),
      canUndo: l.undo.length > 0,
    };
  }

  async create(name: string, repoRoot: string, opts: { dir?: string; author?: string; purpose?: string } = {}) {
    name = name.trim();
    if (!name) throw new OpError('a design needs a name');
    let id = slug(name);
    for (let i = 2; this.live.has(id) || existsSync(designFile(repoRoot, id, opts.dir)); i++) id = `${slug(name)}-${i}`;
    const d = emptyDesign(id, name);
    if (opts.purpose) d.purpose = opts.purpose;
    const author = opts.author || 'you';
    d.participants.push({ name: author, role: 'edit', joinedAt: Date.now() });
    const file = designFile(repoRoot, id, opts.dir);
    const l: Live = { d, file, text: '', undo: [], seen: new Map([[author, Date.now()]]) };
    this.live.set(id, l);
    await this.persist(l, { author, kind: 'create' });
    this.watchFile(l);
    await this.saveIndex();
    return d;
  }

  /** Opens a design file that already exists, e.g. one that came with a clone or a pull. */
  async open(file: string) {
    const l = await this.attach(file);
    await this.saveIndex();
    this.emit(l);
    return l.d;
  }

  async close(id: string) {
    const l = this.need(id);
    l.watcher?.close();
    this.live.delete(l.d.id);
    await this.saveIndex();
  }

  private role(l: Live, author: string): Role {
    if (author === 'you') return 'edit';
    return l.d.participants.find(p => p.name === author)?.role ?? 'edit';
  }
  seen(id: string, author: string) {
    const l = this.need(id);
    const first = !l.seen.has(author) || Date.now() - l.seen.get(author)! > 120_000;
    l.seen.set(author, Date.now());
    if (first) this.emit(l);
  }

  async apply(id: string, ops: Op[], author = 'you') {
    const l = this.need(id);
    const role = this.role(l, author);
    if (role === 'read') throw new OpError(`${author} only reads this design`);
    if (role === 'propose' && !layoutOnly(ops)) throw new OpError(`${author} may only propose changes: use diffboard design propose`);
    const next = applyOps(l.d, ops, author);
    l.undo.push({ rev: l.d.rev, before: l.d, author });
    if (l.undo.length > 200) l.undo.shift();
    next.rev = l.d.rev + 1;
    if (next.approved && !layoutOnly(ops)) next.draft = true;
    l.d = next;
    l.seen.set(author, Date.now());
    await this.persist(l, { author, kind: 'ops', ops });
    return { rev: next.rev, findings: check(next) };
  }

  /** Reverts the model to before the last batch; proposals, comments and people stay as they are. */
  async undo(id: string, author = 'you') {
    const l = this.need(id);
    const last = l.undo.pop();
    if (!last) throw new OpError('nothing to undo');
    const next = clone(l.d);
    for (const k of MODEL_KEYS) (next as any)[k] = clone((last.before as any)[k]);
    next.rev = l.d.rev + 1;
    if (next.approved) next.draft = true;
    l.d = next;
    await this.persist(l, { author, kind: 'undo', revertedRev: last.rev + 1 });
    return { rev: next.rev };
  }

  async propose(id: string, input: { title: string; rationale?: string; ops: Op[] }, author: string) {
    const l = this.need(id);
    if (this.role(l, author) === 'read') throw new OpError(`${author} only reads this design`);
    applyOps(l.d, input.ops, author); // must fit now, or it is not a proposal
    const p: Proposal = {
      id: nextProposalId(l.d), title: String(input.title ?? '').trim() || 'Untitled proposal',
      ...(input.rationale ? { rationale: input.rationale } : {}),
      author, ops: input.ops, status: 'open', createdAt: Date.now(),
    };
    l.d = { ...l.d, proposals: [...l.d.proposals, p] };
    l.seen.set(author, Date.now());
    await this.persist(l, { author, kind: 'propose', proposal: p.id });
    for (const fn of this.proposalListeners) { try { fn(l.d, p); } catch { /* a listener never breaks a proposal */ } }
    return p;
  }

  /** The design as it would be after a proposal (or loose ops), with what changes and what the rules say. */
  preview(id: string, what: { proposal?: string; ops?: Op[] }) {
    const l = this.need(id);
    const p = what.proposal ? l.d.proposals.find(x => x.id === what.proposal) : undefined;
    if (what.proposal && !p) throw new OpError(`no proposal ${what.proposal}`);
    const ops = p ? p.ops : what.ops ?? [];
    try {
      const after = applyOps(l.d, ops, p?.author);
      return { design: after, diff: diffDesigns(l.d, after), findings: check(after), applies: true };
    } catch (e) {
      return { design: l.d, diff: diffDesigns(l.d, l.d), findings: check(l.d), applies: false, error: (e as Error).message };
    }
  }

  async decide(id: string, pid: string, accept: boolean, by = 'you', reason?: string) {
    const l = this.need(id);
    const p = l.d.proposals.find(x => x.id === pid);
    if (!p) throw new OpError(`no proposal ${pid}`);
    if (p.status !== 'open') throw new OpError(`${pid} is already ${p.status}`);
    if (by !== 'you' && this.role(l, by) !== 'edit') throw new OpError(`${by} cannot decide proposals`);
    if (by === p.author && by !== 'you') throw new OpError('a proposal is decided by someone other than its author');
    let next = l.d;
    if (accept) {
      try { next = applyOps(l.d, p.ops, p.author); }
      catch (e) { throw new OpError(`${pid} no longer applies: ${(e as Error).message}`); }
      l.undo.push({ rev: l.d.rev, before: l.d, author: by });
      next.rev = l.d.rev + 1;
      if (next.approved) next.draft = true;
    } else next = clone(l.d);
    const q = next.proposals.find(x => x.id === pid)!;
    q.status = accept ? 'accepted' : 'rejected';
    q.decidedAt = Date.now(); q.decidedBy = by;
    if (reason) q.reason = reason;
    l.d = next;
    await this.persist(l, { author: by, kind: accept ? 'accept' : 'reject', proposal: pid, ...(accept ? { ops: p.ops } : {}) });
    return q;
  }

  async comment(id: string, textIn: string, author: string, target?: string) {
    const l = this.need(id);
    const t = String(textIn ?? '').trim();
    if (!t) throw new OpError('empty comment');
    const c = { id: randomBytes(3).toString('hex'), author, text: t, at: Date.now(), ...(target ? { target } : {}) };
    l.d = { ...l.d, comments: [...l.d.comments, c] };
    l.seen.set(author, Date.now());
    await this.persist(l);
    return c;
  }

  async join(id: string, name: string, role: Role) {
    const l = this.need(id);
    if (!['edit', 'propose', 'read'].includes(role)) throw new OpError('role is edit, propose or read');
    const n = String(name ?? '').trim();
    if (!n || n === 'you') throw new OpError('a participant needs a name other than "you"');
    const participants = l.d.participants.filter(p => p.name !== n);
    participants.push({ name: n, role, joinedAt: l.d.participants.find(p => p.name === n)?.joinedAt ?? Date.now() });
    l.d = { ...l.d, participants };
    l.seen.set(n, Date.now());
    await this.persist(l, { author: n, kind: 'join', role });
    return { name: n, role };
  }

  async leave(id: string, name: string) {
    const l = this.need(id);
    l.d = { ...l.d, participants: l.d.participants.filter(p => p.name !== name) };
    l.seen.delete(name);
    await this.persist(l, { author: name, kind: 'leave' });
  }

  /** Freezes the current model as version N: a snapshot next to the file, the version in the file. */
  async approve(id: string, by = 'you') {
    const l = this.need(id);
    // approval is the human's gate: agents propose and edit, the person signs off
    if (by !== 'you') throw new OpError('only the user approves a version (in the design view, or with --author you)');
    const errors = check(l.d).filter(f => f.level === 'error');
    const version = (l.d.approved?.version ?? 0) + 1;
    const next = clone(l.d);
    next.approved = { version, at: Date.now(), by, rev: l.d.rev };
    delete next.draft;
    l.d = next;
    await mkdir(sideDir(l.file), { recursive: true });
    const snap: Record<string, unknown> = { version, rev: next.rev, approvedAt: next.approved.at, by };
    for (const k of MODEL_KEYS) snap[k] = (next as any)[k];
    await writeFile(join(sideDir(l.file), `v${version}.json`), JSON.stringify(snap, null, 2) + '\n');
    await this.persist(l, { author: by, kind: 'approve', version });
    return { version, errors };
  }

  async version(id: string, version: number) {
    const l = this.need(id);
    return JSON.parse(await readFile(join(sideDir(l.file), `v${version}.json`), 'utf8'));
  }

  async history(id: string, limit = 200) {
    const l = this.need(id);
    try {
      const lines = (await readFile(join(sideDir(l.file), 'history.jsonl'), 'utf8')).trim().split('\n');
      return lines.slice(-limit).map(x => JSON.parse(x)).reverse();
    } catch { return []; }
  }

  closeAll() { for (const l of this.live.values()) l.watcher?.close(); }
}

function nextProposalId(d: Design) {
  let n = 1;
  for (const p of d.proposals) { const m = /^P(\d+)$/.exec(p.id); if (m) n = Math.max(n, Number(m[1]) + 1); }
  return `P${n}`;
}

/** Tolerates files written by hand or by an older version: every list exists. */
function normalize(raw: any): Design {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') throw new Error('not a design file (no id)');
  const d = { ...emptyDesign(raw.id, raw.name ?? raw.id), ...raw } as Design;
  d.rules = { ...emptyDesign('', '').rules, ...(raw.rules ?? {}) };
  for (const k of ['modules', 'tables', 'enums', 'lanes', 'steps', 'flows', 'machines', 'assumptions', 'proposals', 'comments', 'participants'] as const) if (!Array.isArray(d[k])) (d as any)[k] = [];
  for (const t of d.tables) if (!Array.isArray(t.columns)) t.columns = [];
  for (const s of d.steps) if (!Array.isArray(s.touches)) s.touches = [];
  return d;
}
