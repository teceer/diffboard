import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Board, CONFIG_FILE, HOME, loadConfig, type RepoConfig } from './board';

const BOARDS_DIR = join(HOME, 'boards');
const ARCHIVE_DIR = join(HOME, 'archive');
const INDEX_FILE = join(BOARDS_DIR, 'boards.json');

export interface BoardMeta { id: string; name: string; createdAt: number }

const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board';

/**
 * Independent boards served by one process. Each agent session works on its own board, so repos,
 * diff mode, notes, tours and review marks of one session never leak into another.
 * "default" always exists; the unprefixed /api routes and the CLI without --board fall back to it.
 */
export class Boards {
  boards = new Map<string, Board>();
  meta: BoardMeta[] = [];
  private listeners = new Set<(e: { board: string; v: number } | { boards: true }) => void>();

  async load() {
    await mkdir(BOARDS_DIR, { recursive: true });
    try { this.meta = JSON.parse(await readFile(INDEX_FILE, 'utf8')); } catch { await this.migrate(); }
    if (!this.meta.some(m => m.id === 'default')) { this.meta.unshift({ id: 'default', name: 'default', createdAt: Date.now() }); await this.save(); }
    for (const m of this.meta) this.attach(await Board.open(m.id, join(BOARDS_DIR, m.id)));
  }

  /** Before boards: one board's repos and mode in config.json, its notes/tours/marks next to it. */
  private async migrate() {
    const cfg = await loadConfig();
    const dir = join(BOARDS_DIR, 'default');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'board.json'), JSON.stringify({ mode: cfg.mode ?? 'branch', repos: cfg.repos ?? [] }, null, 2));
    for (const f of ['notes.json', 'tours.json', 'reviewed.json']) if (existsSync(join(HOME, f))) await rename(join(HOME, f), join(dir, f));
    await writeFile(CONFIG_FILE, JSON.stringify({ port: cfg.port }, null, 2));
    this.meta = [{ id: 'default', name: 'default', createdAt: Date.now() }];
    await this.save();
  }

  private async save() { await writeFile(INDEX_FILE, JSON.stringify(this.meta, null, 2)); }

  private attach(b: Board) {
    this.boards.set(b.id, b);
    b.onChange(v => this.emit({ board: b.id, v }));
  }

  onChange(fn: (e: { board: string; v: number } | { boards: true }) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(e: { board: string; v: number } | { boards: true }) { for (const l of this.listeners) l(e); }

  get(id: string) { return this.boards.get(id) ?? this.boards.get(this.meta.find(m => m.name === id)?.id ?? ''); }
  get fallback() { return this.boards.get('default')!; }

  async create(name: string, repos: RepoConfig[] = []) {
    name = name.trim() || 'board';
    let id = slug(name);
    for (let i = 2; this.boards.has(id); i++) id = `${slug(name)}-${i}`;
    const b = await Board.open(id, join(BOARDS_DIR, id));
    for (const r of repos) await b.addRepo(r, false);
    await b.persist();
    this.meta.push({ id, name, createdAt: Date.now() });
    await this.save();
    this.attach(b);
    this.emit({ boards: true });
    return b;
  }

  async rename(id: string, name: string) {
    const m = this.meta.find(x => x.id === id);
    if (!m || !name.trim()) return false;
    m.name = name.trim();
    await this.save();
    this.emit({ boards: true });
    return true;
  }

  /** Boards are archived, not deleted: their notes and tours stay in ~/.diffboard/archive. */
  async remove(id: string) {
    const b = this.boards.get(id);
    if (!b || id === 'default') return false;
    b.close();
    this.boards.delete(id);
    this.meta = this.meta.filter(m => m.id !== id);
    await this.save();
    await mkdir(ARCHIVE_DIR, { recursive: true });
    if (existsSync(b.dir)) await rename(b.dir, join(ARCHIVE_DIR, `${id}-${Date.now()}`));
    this.emit({ boards: true });
    return true;
  }

  /** The board a working directory belongs to: the one non-default board watching it, else default. */
  resolve(cwd: string): { id: string } | { error: string } {
    const hits = this.meta.filter(m => m.id !== 'default' && this.boards.get(m.id)?.covers(cwd));
    if (hits.length > 1) return { error: `${cwd} is on several boards (${hits.map(h => h.id).join(', ')}); pass --board <id>` };
    return { id: hits[0]?.id ?? 'default' };
  }

  list() {
    return this.meta.map(m => ({ ...this.boards.get(m.id)!.summary(), name: m.name, createdAt: m.createdAt }));
  }
}
