import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One stop of a review tour; files are addressed by repository path so tours survive restarts. */
export interface TourStep { repoPath: string; path: string; note?: string; start?: number; end?: number }
export interface Tour { name: string; author: string; createdAt: number; updatedAt: number; steps: TourStep[] }

/** A file counts as reviewed only while its content hash matches the one it was reviewed at. */
export interface ReviewMark { hash: string; at: number }

export class ReviewStore {
  tours = new Map<string, Tour>();
  marks = new Map<string, ReviewMark>(); // key: `${repoPath}\0${path}`

  constructor(private toursFile: string, private marksFile: string) {}

  async load() {
    try { for (const t of JSON.parse(await readFile(this.toursFile, 'utf8')) as Tour[]) this.tours.set(t.name, t); } catch {}
    try { for (const [k, v] of Object.entries(JSON.parse(await readFile(this.marksFile, 'utf8')) as Record<string, ReviewMark>)) this.marks.set(k, v); } catch {}
  }

  private async saveTours() {
    await mkdir(join(this.toursFile, '..'), { recursive: true });
    await writeFile(this.toursFile, JSON.stringify([...this.tours.values()], null, 2));
  }
  private async saveMarks() {
    await mkdir(join(this.marksFile, '..'), { recursive: true });
    await writeFile(this.marksFile, JSON.stringify(Object.fromEntries(this.marks), null, 2));
  }

  async setTour(name: string, steps: TourStep[], author: string) {
    const now = Date.now();
    const prev = this.tours.get(name);
    const tour: Tour = { name, author, createdAt: prev?.createdAt ?? now, updatedAt: now, steps };
    this.tours.set(name, tour);
    await this.saveTours();
    return tour;
  }

  async removeTour(name: string) {
    const ok = this.tours.delete(name);
    if (ok) await this.saveTours();
    return ok;
  }

  listTours() { return [...this.tours.values()].sort((a, b) => b.updatedAt - a.updatedAt); }

  key(repoPath: string, path: string) { return `${repoPath}\0${path}`; }

  async mark(repoPath: string, path: string, hash: string | null) {
    const k = this.key(repoPath, path);
    if (hash === null) this.marks.delete(k);
    else this.marks.set(k, { hash, at: Date.now() });
    await this.saveMarks();
  }

  isReviewed(repoPath: string, path: string, hash: string) {
    return this.marks.get(this.key(repoPath, path))?.hash === hash;
  }
}

/** Rough architectural layer from the path: lower layers are read first. */
export function layerOf(path: string): number {
  const p = path.toLowerCase();
  if (/(^|\/)migrations?\//.test(p)) return 0;
  if (/(entity|entities|\.types?\.ts|\/types?\/|\/enums?\/|\.enum\.ts|\/consts?\/|\.const\.ts|schema)/.test(p)) return 1;
  if (/(domain|model|\.dto\.ts|\/dtos?\/)/.test(p) && !/controller/.test(p)) return 2;
  if (/(repository|mapper|storage|\.store\.ts)/.test(p)) return 3;
  if (/(service|use-case|usecase|processor|handler|\.cron\.ts|outbox)/.test(p)) return 4;
  if (/(controller|\.module\.ts|guard|resolver|route)/.test(p)) return 5;
  if (/\.(tsx|jsx|vue|css|scss)$/.test(p) || /(\/app\/|\/components\/|\/pages\/|\/hooks\/)/.test(p)) return 6;
  if (/(\.spec\.|\.test\.|__tests__|\/e2e\/)/.test(p)) return 7;
  return 4;
}

/**
 * Orders changed files so each comes after the changed files it imports:
 * repositories that other watched repos consume go first, then a topological sort of the
 * import graph inside each repo; ties and cycles are broken by layer, then path.
 */
export function autoOrder(
  files: { id: string; repo: string; path: string }[],
  importsOf: (id: string) => string[],
  repoRank: (repo: string) => number,
): string[] {
  const ids = new Set(files.map(f => f.id));
  const byId = new Map(files.map(f => [f.id, f]));
  const deps = new Map<string, Set<string>>();
  for (const f of files) deps.set(f.id, new Set(importsOf(f.id).filter(t => ids.has(t) && t !== f.id)));
  const cmp = (a: string, b: string) => {
    const fa = byId.get(a)!, fb = byId.get(b)!;
    return repoRank(fa.repo) - repoRank(fb.repo) || layerOf(fa.path) - layerOf(fb.path) || fa.path.localeCompare(fb.path);
  };
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < files.length) {
    const ready = files.map(f => f.id).filter(id => !done.has(id) && [...deps.get(id)!].every(d => done.has(d))).sort(cmp);
    // a cycle leaves nothing ready: take the lowest-ranked remaining file to break it
    const next = ready[0] ?? files.map(f => f.id).filter(id => !done.has(id)).sort(cmp)[0];
    done.add(next);
    out.push(next);
  }
  return out;
}
