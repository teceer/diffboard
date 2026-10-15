import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { git, snapshot, type ChangedFile, type DiffMode, type RepoSnapshot } from './git';
import { ImportGraph, packageTarget, type PackageTarget } from './imports';
import { NoteStore, type Note, type NoteLink } from './notes';
import { ReviewStore, autoOrder, type TourStep } from './review';

export const HOME = join(homedir(), '.diffboard');
export const CONFIG_FILE = join(HOME, 'config.json');

export interface RepoConfig { path: string; base?: string }
/** Server-wide settings; repos and mode live per board (the fields here are only read once, to migrate). */
export interface Config { port: number; mode?: DiffMode; repos?: RepoConfig[] }
/** What one board watches and how it diffs, stored as boards/<id>/board.json. */
export interface BoardConfig { mode: DiffMode; repos: RepoConfig[] }

export interface BoardNode {
  id: string;            // `${repoId}:${path}`
  repo: string;
  path: string;
  oldPath?: string;
  status: ChangedFile['status'] | 'N'; // N = neighbour, unchanged
  add: number;
  del: number;
  binary: boolean;
  changedAt?: number;    // last time this file's diff changed while the board was running
}
export interface BoardEdge { from: string; to: string }
export interface Activity { at: number; repo: string; kind: 'file' | 'commit' | 'checkout' | 'base' | 'note'; path?: string; text: string; note?: string }

interface RepoState {
  id: string;
  path: string;
  cfg: RepoConfig;
  snap?: RepoSnapshot;
  error?: string;
  graph: ImportGraph;
  sig: Map<string, string>;     // per-file signature, to detect what changed between refreshes
  hashes: Map<string, string>;  // per-file content hash, for review marks
  changedAt: Map<string, number>;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
  ignored: Set<string>;         // git-ignored directories ("dir/"), so agent worktrees and build output never trigger refreshes
  tooMany?: number;             // changed files when over MAX_FILES
}

export async function loadConfig(): Promise<Config> {
  try { return { port: 4700, ...JSON.parse(await readFile(CONFIG_FILE, 'utf8')) }; }
  catch { return { port: 4700 }; }
}
export async function saveConfig(c: Config) {
  await mkdir(HOME, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(c, null, 2));
}

const IGNORED = /(^|\/)(node_modules|dist|build|\.next|coverage|\.turbo|\.cache)(\/|$)/;
/** Beyond this many changed files a repo is not drawn: hashing, import graphs and the layout would stall. */
export const MAX_FILES = Number(process.env.DIFFBOARD_MAX_FILES) || 800;

/** One whiteboard: its own repos, diff mode, notes, review tours and review marks, in its own directory. */
export class Board {
  repos = new Map<string, RepoState>();
  activity: Activity[] = [];
  version = 0;
  private listeners = new Set<(v: number) => void>();
  private packages = new Map<string, PackageTarget>();
  notes: NoteStore;
  review: ReviewStore;

  constructor(public id: string, public dir: string, public config: BoardConfig) {
    this.notes = new NoteStore(join(dir, 'notes.json'));
    this.review = new ReviewStore(join(dir, 'tours.json'), join(dir, 'reviewed.json'));
  }

  static async open(id: string, dir: string) {
    let cfg: BoardConfig = { mode: 'branch', repos: [] };
    try { cfg = { ...cfg, ...JSON.parse(await readFile(join(dir, 'board.json'), 'utf8')) }; } catch { /* new board */ }
    const b = new Board(id, dir, cfg);
    await b.notes.load();
    await b.review.load();
    for (const r of cfg.repos) await b.addRepo(r, false).catch(() => {});
    return b;
  }

  close() {
    for (const r of this.repos.values()) { r.watcher?.close(); clearTimeout(r.timer); }
    this.repos.clear();
    this.listeners.clear();
  }

  /** The sidebar entry: what the board watches and when something last happened on it. */
  summary() {
    const repos = [...this.repos.values()];
    const files = repos.flatMap(r => r.snap?.files ?? []);
    const last = this.activity[0];
    return {
      id: this.id, version: this.version,
      repos: repos.map(r => ({ id: r.id, path: r.path, branch: r.snap?.branch ?? null, error: r.error ?? null })),
      files: files.length, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0),
      notes: this.notes.list().length, tours: this.review.listTours().length,
      lastAt: last?.at ?? null, lastText: last ? `${last.repo ? last.repo + ': ' : ''}${last.text}` : null,
    };
  }

  /** Whether a path (a working directory) lies inside one of this board's repos. */
  covers(path: string) { return [...this.repos.values()].some(r => path === r.path || path.startsWith(r.path + '/')); }

  /* ---------- notes ---------- */

  /**
   * Turns "repo-id:path[:12[-30]]", "/abs/path/file.ts[:12-30]" or "path:12-30" (single watched repo)
   * into a link; returns null when no watched repo contains the file.
   */
  resolveLink(spec: string): NoteLink | null {
    const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(spec.trim());
    if (!m) return null;
    let target = m[1];
    const start = m[2] ? Number(m[2]) : undefined;
    const end = m[3] ? Number(m[3]) : start;
    const repos = [...this.repos.values()];
    if (target.startsWith('/')) {
      const r = repos.filter(r => target.startsWith(r.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
      return r ? { repoPath: r.path, path: target.slice(r.path.length + 1), start, end } : null;
    }
    for (const r of repos.sort((a, b) => b.id.length - a.id.length)) {
      if (target.startsWith(r.id + ':')) return { repoPath: r.path, path: target.slice(r.id.length + 1), start, end };
      if (target.startsWith(r.id + '/')) return { repoPath: r.path, path: target.slice(r.id.length + 1), start, end };
    }
    if (repos.length === 1) return { repoPath: repos[0].path, path: target.replace(/^\.\//, ''), start, end };
    return null;
  }

  async createNote(input: { title?: string; body?: string; author?: string; links?: string[] }) {
    const links = (input.links ?? []).map(s => this.resolveLink(s));
    const bad = (input.links ?? []).filter((_, i) => !links[i]);
    if (bad.length) throw new Error(`cannot resolve: ${bad.join(', ')}`);
    const note = await this.notes.create({ ...input, links: links as NoteLink[] });
    this.log({ repo: '', kind: 'note', note: note.id, text: `${note.author} added note “${note.title}”` });
    this.bump();
    return note;
  }

  async updateNote(id: string, patch: { title?: string; body?: string; addLinks?: string[]; removeLinks?: string[]; author?: string }) {
    const toLinks = (xs?: string[]) => xs?.map(s => { const l = this.resolveLink(s); if (!l) throw new Error(`cannot resolve: ${s}`); return l; });
    const note = await this.notes.update(id, { title: patch.title, body: patch.body, addLinks: toLinks(patch.addLinks), removeLinks: toLinks(patch.removeLinks) });
    if (note) { this.log({ repo: '', kind: 'note', note: note.id, text: `${patch.author ?? 'you'} updated note “${note.title}”` }); this.bump(); }
    return note;
  }

  async removeNote(id: string) {
    const n = this.notes.get(id);
    const ok = await this.notes.remove(id);
    if (ok && n) { this.log({ repo: '', kind: 'note', text: `note “${n.title}” deleted` }); this.bump(); }
    return ok;
  }

  /* ---------- review ---------- */

  async setTour(name: string, steps: { ref: string; note?: string }[], author: string) {
    const resolved: TourStep[] = [];
    const bad: string[] = [];
    for (const s of steps) {
      const l = this.resolveLink(s.ref);
      if (!l) bad.push(s.ref);
      else resolved.push({ repoPath: l.repoPath, path: l.path, start: l.start, end: l.end, note: s.note?.trim() || undefined });
    }
    if (bad.length) throw new Error(`cannot resolve: ${bad.join(', ')}`);
    const tour = await this.review.setTour(name, resolved, author);
    this.log({ repo: '', kind: 'note', text: `${author} set review tour “${name}” (${resolved.length} steps)` });
    this.bump();
    return tour;
  }

  async removeTour(name: string) {
    const ok = await this.review.removeTour(name);
    if (ok) this.bump();
    return ok;
  }

  async markReviewed(repoId: string, path: string, reviewed: boolean) {
    const r = this.repos.get(repoId);
    const hash = r?.hashes.get(path);
    if (!r || !hash) throw new Error('not a changed file');
    await this.review.mark(r.path, path, reviewed ? hash : null);
    this.bump();
  }

  private reviewView(changed: BoardNode[]) {
    const byPath = new Map([...this.repos.values()].map(r => [r.path, r.id]));
    const repos = [...this.repos.values()];
    // repos imported by other watched repos (libraries) are reviewed first
    const consumed = new Set<string>();
    for (const r of repos) for (const targets of r.graph.imports.values()) for (const t of targets) {
      const i = t.indexOf(':');
      if (i > 0 && this.repos.has(t.slice(0, i)) && t.slice(0, i) !== r.id) consumed.add(t.slice(0, i));
    }
    const repoIndex = new Map(repos.map((r, i) => [r.id, i]));
    const importsOf = (id: string) => {
      const n = changed.find(x => x.id === id)!;
      const r = this.repos.get(n.repo)!;
      return [...(r.graph.imports.get(n.path) ?? [])].map(t => { const i = t.indexOf(':'); return i > 0 && this.repos.has(t.slice(0, i)) ? t : `${n.repo}:${t}`; });
    };
    const order = autoOrder(changed, importsOf, repo => (consumed.has(repo) ? 0 : 1000) + (repoIndex.get(repo) ?? 0));
    const reviewed = changed.filter(n => {
      const r = this.repos.get(n.repo)!;
      const h = r.hashes.get(n.path);
      return !!h && this.review.isReviewed(r.path, n.path, h);
    }).map(n => n.id);
    const tours = this.review.listTours().map(t => ({
      name: t.name, author: t.author, updatedAt: t.updatedAt,
      steps: t.steps.map(s => {
        const repo = byPath.get(s.repoPath) ?? null;
        const id = repo ? `${repo}:${s.path}` : null;
        return { repo, path: s.path, note: s.note, start: s.start, end: s.end, id, changed: !!id && changed.some(c => c.id === id) };
      }),
    }));
    return { order, reviewed, tours };
  }

  private noteView(n: Note) {
    const byPath = new Map([...this.repos.values()].map(r => [r.path, r.id]));
    return {
      id: n.id, title: n.title, body: n.body, author: n.author, createdAt: n.createdAt, updatedAt: n.updatedAt,
      links: n.links.map(l => ({ repo: byPath.get(l.repoPath) ?? null, repoPath: l.repoPath, path: l.path, start: l.start, end: l.end })),
    };
  }

  onChange(fn: (v: number) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private bump() { this.version++; for (const l of this.listeners) l(this.version); }

  private log(a: Omit<Activity, 'at'>) {
    this.activity.unshift({ at: Date.now(), ...a });
    if (this.activity.length > 200) this.activity.length = 200;
  }

  private uniqueId(path: string) {
    const base = basename(path);
    if (![...this.repos.values()].some(r => r.id === base)) return base;
    return `${basename(dirname(path))}/${base}`;
  }

  private rebuildPackages() {
    this.packages.clear();
    for (const r of this.repos.values()) {
      const p = packageTarget(r.id, r.path);
      if (p) this.packages.set(p[0], p[1]);
    }
  }

  async addRepo(cfg: RepoConfig, persist = true) {
    if ([...this.repos.values()].some(r => r.path === cfg.path)) {
      const r = [...this.repos.values()].find(r => r.path === cfg.path)!;
      if (cfg.base !== undefined) r.cfg.base = cfg.base || undefined;
      await this.refreshRepo(r, true);
      if (persist) await this.persist();
      return r.id;
    }
    const id = this.uniqueId(cfg.path);
    const state: RepoState = {
      id, path: cfg.path, cfg: { ...cfg },
      graph: new ImportGraph(cfg.path, id, () => this.packages),
      sig: new Map(), hashes: new Map(), changedAt: new Map(), ignored: new Set(),
    };
    this.repos.set(id, state);
    this.rebuildPackages();
    this.startWatch(state);
    await this.refreshRepo(state, true);
    if (persist) await this.persist();
    return id;
  }

  async removeRepo(idOrPath: string) {
    const r = this.repos.get(idOrPath) ?? [...this.repos.values()].find(x => x.path === idOrPath);
    if (!r) return false;
    r.watcher?.close();
    this.repos.delete(r.id);
    this.rebuildPackages();
    await this.persist();
    this.bump();
    return true;
  }

  async setMode(mode: DiffMode) {
    this.config.mode = mode;
    await this.persist();
    for (const r of this.repos.values()) await this.refreshRepo(r, false, true);
    this.bump();
  }

  async setBase(id: string, base: string | undefined) {
    const r = this.repos.get(id);
    if (!r) return;
    r.cfg.base = base || undefined;
    this.log({ repo: id, kind: 'base', text: base ? `base set to ${base}` : 'base set to auto' });
    await this.persist();
    await this.refreshRepo(r, false, true);
  }

  async persist() {
    this.config.repos = [...this.repos.values()].map(r => ({ path: r.path, ...(r.cfg.base ? { base: r.cfg.base } : {}) }));
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, 'board.json'), JSON.stringify(this.config, null, 2));
  }

  private async loadIgnored(r: RepoState) {
    const out = await git(r.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).catch(() => '');
    r.ignored = new Set(out.split('\0').filter(x => x.endsWith('/')));
  }

  private isIgnored(r: RepoState, f: string) {
    if (IGNORED.test(f)) return true;
    let i = f.indexOf('/');
    while (i > 0) { if (r.ignored.has(f.slice(0, i + 1))) return true; i = f.indexOf('/', i + 1); }
    return false;
  }

  private startWatch(r: RepoState) {
    this.loadIgnored(r);
    try {
      r.watcher = watch(r.path, { recursive: true }, (_e, file) => {
        const f = String(file ?? '');
        if (f.startsWith('.git/') || f === '.git') {
          // only branch moves, commits and the index matter inside .git
          if (!/^\.git\/(HEAD|index|ORIG_HEAD|refs\/|logs\/HEAD)/.test(f)) return;
        } else if (this.isIgnored(r, f)) return;
        if (f.endsWith('.gitignore')) this.loadIgnored(r);
        if (/tsconfig.*\.json$/.test(f)) r.graph.reloadAliases();
        if (f.endsWith('package.json')) this.rebuildPackages();
        clearTimeout(r.timer);
        r.timer = setTimeout(() => this.refreshRepo(r).catch(() => {}), 250);
      });
    } catch (e) { r.error = `watch failed: ${(e as Error).message}`; }
  }

  async refreshRepo(r: RepoState, initial = false, quiet = false) {
    try {
      const prev = r.snap;
      const snap = await snapshot(r.path, this.config.mode, r.cfg.base);
      if (snap.files.length > MAX_FILES) {
        // too big to draw (usually a wrong base): keep the summary, skip hashing, graphs and the nodes
        const was = r.tooMany;
        r.tooMany = snap.files.length;
        r.snap = snap; r.sig = new Map(); r.hashes = new Map(); r.changedAt.clear(); r.error = undefined;
        if (was !== r.tooMany || initial || prev?.base !== snap.base) {
          this.log({ repo: r.id, kind: 'base', text: `${snap.files.length} changed files against ${snap.base}: too many to draw (limit ${MAX_FILES}), change the base` });
          this.bump();
        }
        return;
      }
      r.tooMany = undefined;
      await r.graph.refresh();
      const now = Date.now();
      const nextSig = new Map<string, string>();
      for (const f of snap.files) {
        let mtime = 0;
        try { mtime = Bun.file(join(r.path, f.path)).lastModified; } catch {}
        nextSig.set(f.path, `${f.status}|${f.add}|${f.del}|${f.oldPath ?? ''}|${mtime}`);
      }
      let changed = !prev || prev.head !== snap.head || prev.base !== snap.base || prev.mergeBase !== snap.mergeBase || nextSig.size !== r.sig.size;
      if (!initial && !quiet) {
        if (prev && prev.branch !== snap.branch) this.log({ repo: r.id, kind: 'checkout', text: `checked out ${snap.branch}` });
        else if (prev && prev.head !== snap.head) this.log({ repo: r.id, kind: 'commit', text: `${snap.head.slice(0, 7)} ${snap.headSubject}` });
      }
      for (const [p, s] of nextSig) {
        if (r.sig.get(p) !== s) {
          changed = true;
          if (!initial) {
            r.changedAt.set(p, now);
            if (!quiet) {
              const f = snap.files.find(x => x.path === p)!;
              const verb = f.status === 'D' ? 'deleted' : (f.status === 'A' || f.status === 'U') && !r.sig.has(p) ? 'created' : 'edited';
              this.log({ repo: r.id, kind: 'file', path: p, text: `${verb} ${p} (+${f.add} −${f.del})` });
            }
          }
        }
      }
      for (const p of r.sig.keys()) if (!nextSig.has(p)) { changed = true; r.changedAt.delete(p); if (!initial && !quiet) this.log({ repo: r.id, kind: 'file', path: p, text: `reverted ${p}` }); }
      const prevSig = r.sig;
      r.sig = nextSig;
      const hashes = new Map<string, string>();
      for (const f of snap.files) {
        if (f.status === 'D') { hashes.set(f.path, 'deleted'); continue; }
        // unchanged signature (status, counts, mtime): the content hash still holds
        const old = r.hashes.get(f.path);
        if (old && prevSig.get(f.path) === nextSig.get(f.path)) { hashes.set(f.path, old); continue; }
        try { hashes.set(f.path, createHash('sha1').update(new Uint8Array(await Bun.file(join(r.path, f.path)).arrayBuffer())).digest('hex')); }
        catch { hashes.set(f.path, 'unreadable'); }
      }
      r.hashes = hashes;
      r.snap = snap;
      r.error = undefined;
      if (changed || initial) this.bump();
    } catch (e) {
      r.error = (e as Error).message;
      this.bump();
    }
  }

  findFile(repoId: string, path: string) {
    const r = this.repos.get(repoId);
    const f = r?.snap?.files.find(x => x.path === path);
    return r && f ? { repo: r, file: f } : null;
  }

  /** Changed files of every repo plus their one-step import neighbours, with the edges between them. */
  state() {
    const nodes = new Map<string, BoardNode>();
    const edges = new Map<string, BoardEdge>();
    const key = (repo: string, p: string) => `${repo}:${p}`;
    const splitTarget = (repo: string, t: string) => {
      const i = t.indexOf(':');
      if (i > 0 && this.repos.has(t.slice(0, i))) return { repo: t.slice(0, i), path: t.slice(i + 1) };
      return { repo, path: t };
    };

    for (const r of this.repos.values()) {
      if (r.tooMany) continue;
      for (const f of r.snap?.files ?? []) {
        nodes.set(key(r.id, f.path), { id: key(r.id, f.path), repo: r.id, path: f.path, oldPath: f.oldPath, status: f.status, add: f.add, del: f.del, binary: f.binary, changedAt: r.changedAt.get(f.path) });
      }
    }
    const changed = [...nodes.values()];
    const addNeighbour = (repo: string, path: string) => {
      const id = key(repo, path);
      if (!nodes.has(id)) nodes.set(id, { id, repo, path, status: 'N', add: 0, del: 0, binary: false });
      return id;
    };
    for (const n of changed) {
      const r = this.repos.get(n.repo)!;
      for (const t of r.graph.imports.get(n.path) ?? []) {
        const { repo, path } = splitTarget(n.repo, t);
        const to = addNeighbour(repo, path);
        edges.set(`${n.id}>${to}`, { from: n.id, to });
      }
      // importers inside the same repo, and in other repos that import this file through a package
      for (const other of this.repos.values()) {
        const target = other.id === n.repo ? n.path : `${n.repo}:${n.path}`;
        for (const imp of other.graph.importers.get(target) ?? []) {
          const from = addNeighbour(other.id, imp);
          edges.set(`${from}>${n.id}`, { from, to: n.id });
        }
      }
    }
    // edges among neighbours too, so the picture is not misleadingly sparse
    for (const n of nodes.values()) {
      if (n.status !== 'N') continue;
      const r = this.repos.get(n.repo);
      for (const t of r?.graph.imports.get(n.path) ?? []) {
        const { repo, path } = splitTarget(n.repo, t);
        const to = key(repo, path);
        if (nodes.has(to)) edges.set(`${n.id}>${to}`, { from: n.id, to });
      }
    }

    // files that notes point at join the board even when unchanged
    const notes = this.notes.list().map(n => this.noteView(n));
    for (const n of notes) for (const l of n.links) if (l.repo) addNeighbour(l.repo, l.path);

    const repos = [...this.repos.values()].map(r => ({
      id: r.id, path: r.path, branch: r.snap?.branch, head: r.snap?.head?.slice(0, 7), headSubject: r.snap?.headSubject,
      base: r.snap?.base, baseSource: r.snap?.baseSource, configuredBase: r.cfg.base ?? null, mergeBase: r.snap?.mergeBase?.slice(0, 7),
      files: r.snap?.files.length ?? 0, add: r.snap?.files.reduce((s, f) => s + f.add, 0) ?? 0, del: r.snap?.files.reduce((s, f) => s + f.del, 0) ?? 0,
      error: r.error, tooMany: r.tooMany ?? null,
    }));
    const signature = createHash('sha1').update(JSON.stringify([...nodes.keys(), ...edges.keys(), ...notes.map(n => n.id + n.links.map(l => l.repo + l.path).join())])).digest('hex').slice(0, 10);
    const review = this.reviewView(changed);
    return { version: this.version, mode: this.config.mode, generatedAt: Date.now(), repos, nodes: [...nodes.values()], edges: [...edges.values()], notes, review, activity: this.activity.slice(0, 80), topology: signature };
  }
}
