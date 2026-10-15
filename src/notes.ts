import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** A note points at files by repository path, so links survive repo-id changes and restarts. */
export interface NoteLink { repoPath: string; path: string; start?: number; end?: number }
export interface Note {
  id: string;
  title: string;
  body: string;          // markdown; ```mermaid fences render as diagrams
  author: string;        // "you" or "agent:<name>"
  createdAt: number;
  updatedAt: number;
  links: NoteLink[];
}

export class NoteStore {
  private notes = new Map<string, Note>();
  constructor(private file: string) {}

  async load() {
    try {
      const list: Note[] = JSON.parse(await readFile(this.file, 'utf8'));
      for (const n of list) this.notes.set(n.id, n);
    } catch { /* first run */ }
  }

  private async save() {
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify([...this.notes.values()], null, 2));
  }

  list() { return [...this.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id: string) { return this.notes.get(id) ?? this.list().find(n => n.id.startsWith(id)); }

  async create(input: { title?: string; body?: string; author?: string; links?: NoteLink[] }) {
    const now = Date.now();
    const note: Note = {
      id: randomBytes(4).toString('hex'),
      title: input.title?.trim() || 'Untitled note',
      body: input.body ?? '',
      author: input.author || 'you',
      createdAt: now, updatedAt: now,
      links: dedupe(input.links ?? []),
    };
    this.notes.set(note.id, note);
    await this.save();
    return note;
  }

  async update(id: string, patch: Partial<Pick<Note, 'title' | 'body'>> & { addLinks?: NoteLink[]; removeLinks?: NoteLink[] }) {
    const n = this.get(id);
    if (!n) return null;
    if (patch.title !== undefined) n.title = patch.title.trim() || n.title;
    if (patch.body !== undefined) n.body = patch.body;
    if (patch.addLinks) n.links = dedupe([...n.links, ...patch.addLinks]);
    if (patch.removeLinks) n.links = n.links.filter(l => !patch.removeLinks!.some(r => sameLink(l, r)));
    n.updatedAt = Date.now();
    await this.save();
    return n;
  }

  async remove(id: string) {
    const n = this.get(id);
    if (!n) return false;
    this.notes.delete(n.id);
    await this.save();
    return true;
  }
}

const sameLink = (a: NoteLink, b: NoteLink) => a.repoPath === b.repoPath && a.path === b.path && (a.start ?? 0) === (b.start ?? 0) && (a.end ?? 0) === (b.end ?? 0);
function dedupe(links: NoteLink[]) {
  const out: NoteLink[] = [];
  for (const l of links) if (!out.some(o => sameLink(o, l))) out.push(l);
  return out;
}
